import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChargebeeService } from '../billing/chargebee.service';
import { DomainsService } from '../domains/domains.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgencyUpdatedEvent } from './events/agency-updated.event';
import { resolveDateRange } from '../helpers/date-range.helper';
import { WorkspaceResource } from './resources/workspace.resource';
import { EntriService } from '../libraries/entri.service';
import { DomainCacheService } from '../cache/domain-cache.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
    private readonly domainsService: DomainsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly entri: EntriService,
    private readonly domainCache: DomainCacheService,
  ) {}

  /**
   * Hard-delete an agency that is in CLOSED status. Mirrors gateway's
   * DeleteAgency job: deletes workspaces, non-owner users, all domains
   * (with Entri cleanup for non-default), then the agency row.
   *
   * Safety: refuses to run unless agency.status === 'CLOSED'.
   */
  async deleteAgency(agencyId: bigint): Promise<any> {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    if (agency.status !== 'CLOSED') {
      throw new BadRequestException(
        'Agency must be CLOSED before it can be deleted',
      );
    }

    this.logger.log(`Deleting agency ${agency.name} (${agency.id})`);

    // 1. Soft-delete workspaces
    await this.prisma.workspaces.updateMany({
      where: { agency_id: agency.id },
      data: { deleted_at: new Date() },
    });

    // 2. Delete non-owner users (pending/active)
    await this.prisma.users.deleteMany({
      where: {
        modelable_id: agency.id,
        modelable_type: 'App\\Models\\Agency',
        is_owner: false,
        status: { in: ['PENDING', 'ACTIVE'] },
      },
    });

    // 3. Delete domains — Entri cleanup for custom (non-default) domains
    const domains = await this.prisma.domains.findMany({
      where: {
        modelable_id: agency.id,
        modelable_type: 'App\\Models\\Agency',
      },
    });

    for (const d of domains) {
      // Cache invalidate first
      const host = (d.domain || '').replace(/^https?:\/\//, '');
      if (host) await this.domainCache.invalidate(host);

      if (!d.is_default) {
        try {
          await this.entri.deletePowerDomain(`${d.sub_domain}.${d.root_domain}`);
        } catch (err) {
          this.logger.error(
            `Entri delete failed for domain ${d.id}, manual cleanup needed: ${err.message}`,
          );
        }
      }
      await this.prisma.domains.delete({ where: { id: d.id } });
    }

    // 4. Delete the agency row itself
    await this.prisma.agencies.delete({ where: { id: agencyId } });

    return { success: true, message: `Agency ${agencyId} deleted` };
  }

  /**
   * Compute dirty attributes (Laravel parity) — only fields that actually
   * changed against the existing row. Returns {} if nothing changed.
   */
  private computeDirty(
    before: Record<string, any>,
    incoming: Record<string, any>,
  ): Record<string, any> {
    const dirty: Record<string, any> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      if (before[key] !== value) {
        dirty[key] = value;
      }
    }
    return dirty;
  }

  // ─── Agency Profile & Branding ──────────────────────────────────────
  
  async getAgency(agencyId: bigint) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: agencyId, brandable_type: 'App\\Models\\Agency' }
    });


    const address = await this.prisma.addresses.findFirst({
      where: {
        addressable_id: agencyId,
        addressable_type: 'App\\Models\\Agency',
      },
    });

    return { 
      success: true, 
      agency: {
        ...this.serialize(agency),
        branding: branding ? this.serialize(branding) : null,
        address: address ? this.serialize(address) : null
      } 
    };

  }


  async updateAgency(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const address = await this.prisma.addresses.findFirst({
      where: {
        addressable_id: agencyId,
        addressable_type: 'App\\Models\\Agency',
      },
    });

    const incoming: any = {
      name: data.name,
      email: data.email,
      notification_email: data.notification_email,
      timezone: data.timezone,
      notification_language: data.notification_language,
      tax_id: data.tax_id,
      vat: data.vat,
      billing_company: data.billing_company,
      billing_person: data.billing_person,
    };
    if (data.status !== undefined) incoming.status = data.status;
    if (data.branding_enabled !== undefined)
      incoming.branding_enabled = data.branding_enabled;

    const dirty = this.computeDirty(agency as any, incoming);

    const updated = await this.prisma.agencies.update({
      where: { id: agencyId },
      data: incoming,
    });

    if (Object.keys(dirty).length > 0) {
      this.eventEmitter.emit(
        AgencyUpdatedEvent.NAME,
        new AgencyUpdatedEvent(agencyId, dirty, data.user_id ?? null),
      );
    }

    // Sync with Chargebee
    if (agency.customer_id) {
      const nameArr = (data.billing_person || '').split(' ');
      const firstName = nameArr[0];
      const lastName = nameArr.slice(1).join(' ');

      try {
        await this.chargebee.updateCustomer(agency.customer_id, {
          first_name: firstName,
          last_name: lastName,
          company: data.billing_company,
          email: data.email || agency.email,
          cf_tax_id: data.tax_id,
          cf_vat_number: data.vat,
        });
      } catch (err) {
        this.logger.error(`Chargebee Sync Error: ${err.message}`);
      }
    }

    await this.logAgencyEvent(agencyId, 'agency_updated', data.user_id, 'App\\Models\\Agency', agencyId, data);

    return { success: true, agency: this.serialize(updated) };
  }

  async updateBillingAddress(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');

    const billingAddress = {
      line1: data.address?.street,
      city: data.address?.city,
      state: data.address?.state,
      zip: data.address?.zip,
      country: data.address?.country_iso2,
    };

    if (agency.customer_id) {
      await this.chargebee.updateCustomerBillingAddress(agency.customer_id, billingAddress);
    }

    // Update local address
    await this.prisma.addresses.upsert({
      where: { id: data.address?.id || 0 }, // Simplified
      update: {
        street: data.address?.street,
        city: data.address?.city,
        state: data.address?.state,
        zip: data.address?.zip,
      },
      create: {
        addressable_id: agencyId,
        addressable_type: 'App\\Models\\Agency',
        street: data.address?.street,
        city: data.address?.city,
        state: data.address?.state,
        zip: data.address?.zip,
      },
    });

    return { success: true };
  }

  async updateBranding(agencyId: bigint, data: any) {
    const before = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!before) throw new NotFoundException('Agency not found');

    const newEnabled = data.enabled ?? true;

    // 1. Enable/Disable branding on agency
    await this.prisma.agencies.update({
      where: { id: agencyId },
      data: { branding_enabled: newEnabled },
    });

    // Emit only if branding_enabled actually flipped — listener handles cleanup/audit
    if (before.branding_enabled !== newEnabled) {
      this.eventEmitter.emit(
        AgencyUpdatedEvent.NAME,
        new AgencyUpdatedEvent(
          agencyId,
          { branding_enabled: newEnabled },
          data.user_id ?? null,
        ),
      );
    }

    // 2. Fetch or create branding record
    let branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: agencyId, brandable_type: 'App\\Models\\Agency' }
    });

    if (!branding) {
      branding = await this.prisma.brandings.create({
        data: {
          brandable_id: agencyId,
          brandable_type: 'App\\Models\\Agency',
          color: '#0a7a22',
        }
      });
    }

    // 3. Update branding details
    const updateData: any = {};
    if (data.mainTheme !== undefined) updateData.color = data.mainTheme;
    if (data.links !== undefined) updateData.link_color = data.links;
    if (data.incomingBubble !== undefined) updateData.incoming_chat_color = data.incomingBubble;
    if (data.incomingText !== undefined) updateData.incoming_chat_text_color = data.incomingText;
    if (data.outgoingBubble !== undefined) updateData.outgoing_chat_color = data.outgoingBubble;
    if (data.outgoingText !== undefined) updateData.outgoing_chat_text_color = data.outgoingText;
    
    // Logo and Favicon IDs
    if (data.logoLightId !== undefined) updateData.mid_logo_light = BigInt(data.logoLightId);
    if (data.logoLightSmallId !== undefined) updateData.mid_logo_light_small = BigInt(data.logoLightSmallId);
    if (data.logoDarkId !== undefined) updateData.mid_logo_dark = BigInt(data.logoDarkId);
    if (data.logoDarkSmallId !== undefined) updateData.mid_logo_dark_small = BigInt(data.logoDarkSmallId);
    if (data.faviconId !== undefined) updateData.favicon_media_id = BigInt(data.faviconId);

    return this.prisma.brandings.update({
      where: { id: branding.id },
      data: updateData,
    });
  }

  // ─── Workspace Management ───────────────────────────────────────────

  async getWorkspaces(agencyId: bigint) {
    const workspaces = await this.prisma.workspaces.findMany({
      where: { agency_id: agencyId, deleted_at: null },
      orderBy: { created_at: 'desc' }
    });
    return { success: true, workspaces: this.serialize(workspaces) };
  }


  async workspaceCheckout(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    // Validation
    if (!data.name || data.name.length < 3 || data.name.length > 100)
      throw new BadRequestException('Name must be between 3 and 100 chars');
    if (
      !data.subdomain ||
      data.subdomain.length < 3 ||
      data.subdomain.length > 30
    )
      throw new BadRequestException(
        'Subdomain must be between 3 and 30 chars',
      );
    if (!data.timezone) throw new BadRequestException('Timezone is required');

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (!subscription || !subscription.billing_plan_id)
      throw new BadRequestException('Subscription or Plan not found');

    const plan = await this.prisma.billing_plans.findUnique({
      where: { id: subscription.billing_plan_id },
    });
    if (!plan) throw new BadRequestException('Plan not found');

    const totalWorkspaces = await this.prisma.workspaces.count({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (totalWorkspaces >= plan.maximum_workspaces)
      throw new BadRequestException('Workspace limit reached');

    const nameExists = await this.prisma.workspaces.findFirst({
      where: { agency_id: agencyId, name: data.name, deleted_at: null },
    });
    if (nameExists)
      throw new BadRequestException('Workspace name not available');

    const subdomainExists = await this.prisma.domains.findFirst({
      where: { sub_domain: data.subdomain.toLowerCase() },
    });
    if (subdomainExists)
      throw new BadRequestException('Subdomain not available');

    const allow_branding = !!data.allow_branding;
    const allow_agents = !!data.allow_agents;
    const agents_limit = parseInt(data.agents_limit) || 0;
    if (allow_agents && agents_limit <= 0)
      throw new BadRequestException(
        'You must select the number of agents',
      );

    // Build estimation
    const estimation: any = {
      line_items: {} as Record<string, any>,
      sub_total: 0,
      discount: 0,
      total: 0,
      currency_code: 'USD',
    };

    const subscriptionItems: any[] = [];
    const extraWorkspaces = totalWorkspaces + 1 - plan.free_workspaces;
    const isFree = extraWorkspaces <= 0;

    const wsAddon = await this.prisma.billing_addons.findFirst({
      where: { name: process.env.BILLING_WORKSPACE_ADDON },
    });
    const wsPrice =
      wsAddon &&
      (await this.prisma.billing_item_prices.findFirst({
        where: {
          itemable_id: wsAddon.id,
          itemable_type: 'App\\Models\\BillingAddon',
          currency_code: 'USD',
        },
      }));
    if (wsAddon && wsPrice) {
      estimation.line_items[wsPrice.price_id] = {
        entity_id: wsPrice.price_id,
        addon_id: wsAddon.id.toString(),
        unit_amount: (wsPrice.price || 0) / 100,
        amount: 0,
        discount_amount: 0,
        description: wsAddon.name,
        currency_code: 'USD',
      };
      if (!isFree) {
        subscriptionItems.push({
          item_price_id: wsPrice.price_id,
          quantity: extraWorkspaces,
          proration_type: 'partial_term',
        });
      }
    }

    if (allow_branding && !plan.free_workspace_branding) {
      const totalBrandings =
        (await this.prisma.workspaces.count({
          where: {
            agency_id: agencyId,
            allow_branding: true,
            deleted_at: null,
          },
        })) + 1;

      const brAddon = await this.prisma.billing_addons.findFirst({
        where: { name: process.env.BILLING_BRANDING_ADDON },
      });
      const brPrice =
        brAddon &&
        (await this.prisma.billing_item_prices.findFirst({
          where: {
            itemable_id: brAddon.id,
            itemable_type: 'App\\Models\\BillingAddon',
            currency_code: 'USD',
          },
        }));
      if (brAddon && brPrice) {
        estimation.line_items[brPrice.price_id] = {
          entity_id: brPrice.price_id,
          addon_id: brAddon.id.toString(),
          unit_amount: (brPrice.price || 0) / 100,
          amount: 0,
          discount_amount: 0,
          description: brAddon.name,
          currency_code: 'USD',
        };
        subscriptionItems.push({
          item_price_id: brPrice.price_id,
          quantity: totalBrandings,
          proration_type: 'partial_term',
        });
      }
    }

    try {
      const estimate = await this.chargebee.estimateUpdateSubscriptionForItems(
        {
          invoice_immediately: false,
          subscription: { id: subscription.subscription_id },
          prorate: true,
          subscription_items: subscriptionItems,
        },
      );

      const charges = estimate?.estimate?.unbilled_charge_estimates || [];
      for (const li of charges) {
        if (!estimation.line_items[li.entity_id]) {
          estimation.line_items[li.entity_id] = { entity_id: li.entity_id };
        }
        estimation.line_items[li.entity_id].description = li.description;
        estimation.line_items[li.entity_id].amount = (li.amount || 0) / 100;
        estimation.line_items[li.entity_id].discount_amount =
          (li.discount_amount || 0) / 100;
        estimation.line_items[li.entity_id].currency_code = li.currency_code;

        estimation.total +=
          ((li.amount || 0) - (li.discount_amount || 0)) / 100;
        estimation.discount += (li.discount_amount || 0) / 100;
        estimation.sub_total += (li.amount || 0) / 100;
      }

      return { success: true, estimate: estimation };
    } catch (err) {
      throw new BadRequestException(`Estimation failed: ${err.message}`);
    }
  }

  async createWorkspace(agencyId: bigint, data: any, creatorId: bigint) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    // ─── Validation (gateway parity) ─────────────────────────────────
    if (!data.name || data.name.length < 3 || data.name.length > 100) {
      throw new BadRequestException('Name must be between 3 and 100 chars');
    }
    if (
      !data.subdomain ||
      data.subdomain.length < 3 ||
      data.subdomain.length > 30
    ) {
      throw new BadRequestException(
        'Subdomain must be between 3 and 30 chars',
      );
    }
    if (!data.timezone) {
      throw new BadRequestException('Timezone is required');
    }

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    const plan =
      subscription && subscription.billing_plan_id
        ? await this.prisma.billing_plans.findUnique({
            where: { id: subscription.billing_plan_id },
          })
        : null;

    const totalWorkspaces = await this.prisma.workspaces.count({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (!subscription || !plan || totalWorkspaces >= plan.maximum_workspaces) {
      throw new BadRequestException('Workspace limit reached');
    }

    // Workspace name uniqueness within agency
    const nameExists = await this.prisma.workspaces.findFirst({
      where: { agency_id: agencyId, name: data.name, deleted_at: null },
    });
    if (nameExists)
      throw new BadRequestException('Workspace name not available');

    // Subdomain uniqueness
    const subdomainExists = await this.prisma.domains.findFirst({
      where: { sub_domain: data.subdomain.toLowerCase() },
    });
    if (subdomainExists)
      throw new BadRequestException('Subdomain not available');

    const allow_branding = !!data.allow_branding;
    const allow_agents = !!data.allow_agents;
    const allow_support = !!data.allow_support;
    const agents_limit = parseInt(data.agents_limit) || 0;

    if (allow_agents && agents_limit <= 0) {
      throw new BadRequestException(
        'You must select the number of agents',
      );
    }

    const totalBrandings = await this.prisma.workspaces.count({
      where: {
        agency_id: agencyId,
        allow_branding: true,
        deleted_at: null,
      },
    });

    // ─── Build subscription items (workspace + branding addons) ──────
    const subscriptionItems: any[] = [];
    const extraWorkspaces = totalWorkspaces + 1 - plan.free_workspaces;
    const isWorkspaceFree = extraWorkspaces <= 0;

    if (!isWorkspaceFree) {
      const wsAddon = await this.prisma.billing_addons.findFirst({
        where: { name: process.env.BILLING_WORKSPACE_ADDON },
      });
      const wsPrice =
        wsAddon &&
        (await this.prisma.billing_item_prices.findFirst({
          where: {
            itemable_id: wsAddon.id,
            itemable_type: 'App\\Models\\BillingAddon',
            currency_code: 'USD',
          },
        }));
      if (wsPrice) {
        subscriptionItems.push({
          item_price_id: wsPrice.price_id,
          quantity: extraWorkspaces,
        });
      }
    }

    if (allow_branding && !plan.free_workspace_branding) {
      const brAddon = await this.prisma.billing_addons.findFirst({
        where: { name: process.env.BILLING_BRANDING_ADDON },
      });
      const brPrice =
        brAddon &&
        (await this.prisma.billing_item_prices.findFirst({
          where: {
            itemable_id: brAddon.id,
            itemable_type: 'App\\Models\\BillingAddon',
            currency_code: 'USD',
          },
        }));
      if (brPrice) {
        subscriptionItems.push({
          item_price_id: brPrice.price_id,
          quantity: totalBrandings + 1,
        });
      }
    }

    // ─── Create + Chargebee charge in transaction ────────────────────
    const slug = data.slug || this.makeSlug(data.name);

    const workspace = await this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspaces.create({
        data: {
          name: data.name,
          slug,
          agency_id: agencyId,
          creator_id: creatorId,
          agency_agent_id: data.creator_id
            ? BigInt(data.creator_id)
            : creatorId,
          timezone: data.timezone,
          allow_branding,
          allow_agents,
          allow_support,
          agents_limit,
          limited_contacts: data.limited_contacts ?? false,
          maximum_contacts: data.maximum_contacts ?? 0,
          whatsapp_channels_limit: data.whatsapp_channels_limit ?? 0,
          instagram_channels_limit: data.instagram_channels_limit ?? 0,
          facebook_channels_limit: data.facebook_channels_limit ?? 0,
          telegram_channels_limit: data.telegram_channels_limit ?? 0,
          twilio_channels_limit: data.twilio_channels_limit ?? 0,
          evolution_channels_limit: data.evolution_channels_limit ?? 0,
          zapi_channels_limit: data.zapi_channels_limit ?? 0,
          webchat_channels_limit: data.webchat_channels_limit ?? 0,
          status: 'ACTIVE',
          contacts_counter: 0,
          chatgpt_assistant_limit: plan.free_ai_agents ?? 0,
        },
      });

      if (subscriptionItems.length > 0) {
        try {
          await this.chargebee.updateSubscriptionForItems(
            subscription.subscription_id,
            {
              prorate: true,
              invoice_immediately: true,
              subscription_items: subscriptionItems,
            },
          );
        } catch (err) {
          this.logger.error(`Chargebee charge failed: ${err.message}`);
          throw new BadRequestException(`Payment failed: ${err.message}`);
        }
      }

      return ws;
    });

    // ─── Create + activate default domain (subdomain.accounts_domain) ─
    const subDomainLower = data.subdomain.toLowerCase();
    const rootDomain = process.env.ACCOUNTS_DOMAIN || 'ezconn.io';
    await this.domainsService.addCustomDomain(
      workspace.id,
      'WORKSPACE',
      subDomainLower,
      rootDomain,
      creatorId,
    );

    await this.logAgencyEvent(
      agencyId,
      'workspace_created',
      creatorId,
      'App\\Models\\Workspace',
      workspace.id,
      { workspace_name: workspace.name },
    );

    return { workspace: await this.hydrateWorkspace(workspace.id) };
  }

  /**
   * Loads workspace + branding + creator + domains and shapes them via
   * WorkspaceResource — gateway parity with loadMissing chain.
   */
  private async hydrateWorkspace(workspaceId: bigint): Promise<any> {
    const ws = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
    });
    if (!ws) return null;

    const [branding, creator, domains] = await Promise.all([
      this.prisma.brandings.findFirst({
        where: {
          brandable_id: workspaceId,
          brandable_type: 'App\\Models\\Workspace',
        },
      }),
      ws.creator_id
        ? this.prisma.users.findUnique({
            where: { id: ws.creator_id },
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.domains.findMany({
        where: {
          modelable_id: workspaceId,
          modelable_type: 'App\\Models\\Workspace',
        },
      }),
    ]);

    return WorkspaceResource.toJSON({
      workspace: ws,
      branding,
      creator,
      active_domain: domains.find((d) => d.active && !d.is_default),
      system_domain: domains.find((d) => d.is_default),
      domains,
    });
  }

  private makeSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  async updateWorkspace(workspaceId: bigint, agencyId: bigint, data: any) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace)
      throw new NotFoundException('Workspace not found in this agency');

    const updated = await this.prisma.workspaces.update({
      where: { id: workspaceId },
      data: {
        name: data.name,
        allow_branding: data.allow_branding,
        allow_agents: data.allow_agents,
        agents_limit: data.agents_limit,
      },
    });

    return { success: true, workspace: this.serialize(updated) };
  }

  async suspendWorkspace(workspaceId: bigint, agencyId: bigint) {
    return { success: true };
  }

  async activateWorkspace(workspaceId: bigint, agencyId: bigint) {
    return { success: true };
  }

  async deleteWorkspace(workspaceId: bigint, agencyId: bigint) {
    return { success: true };
  }

  async getWorkspaceUsage(workspaceId: bigint, agencyId: bigint) {
    return { success: true };
  }

  // ─── Member Management ──────────────────────────────────────────────

  async members(agencyId: bigint) {
    const users = await this.prisma.users.findMany({
      where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    return { success: true, members: this.serialize(users) };
  }


  async getMember(agencyId: bigint, memberId: bigint) {
    return { success: true, member: null };
  }

  async updateMember(agencyId: bigint, memberId: bigint, data: any) {
    return { success: true };
  }

  async removeMember(agencyId: bigint, memberId: bigint) {
    return { success: true };
  }

  // ─── Logs ──────────────────────────────────────────────────────────

  async getAuditLogs(workspaceId: bigint, filters: any = {}) {
    const page = parseInt(filters.page) || 1;
    const perPage = parseInt(filters.per_page) || 10;

    const where: any = { workspace_id: workspaceId };

    if (filters.events && Array.isArray(filters.events) && filters.events.length) {
      where.event = { in: filters.events };
    }
    if (filters.members && Array.isArray(filters.members) && filters.members.length) {
      where.user_id = { in: filters.members.map((m: any) => BigInt(m)) };
    }
    if (filters.date_range) {
      const bounds = resolveDateRange(
        filters.date_range,
        filters.custom_range,
        filters.first_day_week ?? 0,
      );
      if (bounds.gte || bounds.lte) where.created_at = bounds;
    } else if (filters.from || filters.to) {
      where.created_at = {};
      if (filters.from) where.created_at.gte = new Date(filters.from);
      if (filters.to) where.created_at.lte = new Date(filters.to);
    }

    const [items, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    // Hydrate user + workspace fields (manual join — schema has no relation defined)
    const userIds = Array.from(
      new Set(items.map((i) => i.user_id).filter(Boolean) as bigint[]),
    );
    const workspaceIds = Array.from(
      new Set(items.map((i) => i.workspace_id).filter(Boolean) as bigint[]),
    );

    const [users, workspaces] = await Promise.all([
      userIds.length
        ? this.prisma.users.findMany({
            where: { id: { in: userIds } },
            select: { id: true, first_name: true, last_name: true, email: true },
          })
        : Promise.resolve([]),
      workspaceIds.length
        ? this.prisma.workspaces.findMany({
            where: { id: { in: workspaceIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const wsMap = new Map(workspaces.map((w) => [w.id.toString(), w]));

    const hydrated = items.map((log) => ({
      ...log,
      user: log.user_id ? userMap.get(log.user_id.toString()) || null : null,
      workspace: wsMap.get(log.workspace_id.toString()) || null,
    }));

    return {
      success: true,
      data: this.serialize(hydrated),
      total,
      current_page: page,
      per_page: perPage,
      last_page: Math.ceil(total / perPage),
    };
  }

  async getAgencyLogs(agencyId: bigint, filters: any = {}) {
    const page = parseInt(filters.page) || 1;
    const perPage = parseInt(filters.per_page) || 10;

    const where: any = { agency_id: agencyId };

    if (filters.events && Array.isArray(filters.events) && filters.events.length) {
      where.event = { in: filters.events };
    }
    if (filters.members && Array.isArray(filters.members) && filters.members.length) {
      where.user_id = { in: filters.members.map((m: any) => BigInt(m)) };
    }
    if (filters.date_range) {
      const bounds = resolveDateRange(
        filters.date_range,
        filters.custom_range,
        filters.first_day_week ?? 0,
      );
      if (bounds.gte || bounds.lte) where.created_at = bounds;
    } else if (filters.from || filters.to) {
      where.created_at = {};
      if (filters.from) where.created_at.gte = new Date(filters.from);
      if (filters.to) where.created_at.lte = new Date(filters.to);
    }

    const [items, total] = await Promise.all([
      this.prisma.agency_logs.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.agency_logs.count({ where }),
    ]);

    const userIds = Array.from(
      new Set(items.map((i) => i.user_id).filter(Boolean) as bigint[]),
    );
    const users = userIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: userIds } },
          select: { id: true, first_name: true, last_name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));

    const hydrated = items.map((log) => ({
      ...log,
      user: log.user_id ? userMap.get(log.user_id.toString()) || null : null,
    }));

    return {
      success: true,
      data: this.serialize(hydrated),
      total,
      current_page: page,
      per_page: perPage,
      last_page: Math.ceil(total / perPage),
    };
  }

  async addMember(agencyId: bigint, data: any) {
    const hashedPassword = await bcrypt.hash(data.password, 10);
    const user = await this.prisma.users.create({
      data: {
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        password: hashedPassword,
        modelable_id: agencyId,
        modelable_type: 'App\\Models\\Agency',
        status: 'ACTIVE',
        creator_id: 0n, // or actual creator ID if passed, but typically system/admin
      },
    });
    return { success: true, user: this.serialize(user) };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async logAgencyEvent(
    agencyId: bigint,
    event: string,
    userId: bigint,
    modelableType?: string,
    modelableId?: bigint,
    data?: any,
  ) {
    await this.prisma.agency_logs.create({
      data: {
        agency_id: agencyId,
        event: event,
        user_id: userId,
        modelable_type: modelableType,
        modelable_id: modelableId,
        data: data ? JSON.stringify(data) : null,
      },
    });
  }

  private serialize(obj: any) {
    return JSON.parse(
      JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
