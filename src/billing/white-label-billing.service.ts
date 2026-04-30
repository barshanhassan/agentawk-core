import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChargebeeService } from './chargebee.service';
import { DomainsService } from '../domains/domains.service';
import { EntriService } from '../libraries/entri.service';
import { DomainCacheService } from '../cache/domain-cache.service';
import { SubscriptionRecomputeService } from './subscription-recompute.service';
import { WorkspaceResource } from '../agency/resources/workspace.resource';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgencyUpdatedEvent } from '../agency/events/agency-updated.event';

@Injectable()
export class WhiteLabelBillingService {
  private readonly logger = new Logger(WhiteLabelBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
    private readonly domainsService: DomainsService,
    private readonly entri: EntriService,
    private readonly domainCache: DomainCacheService,
    private readonly recompute: SubscriptionRecomputeService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Hydrates a workspace with branding, creator, active_domain, system_domain
   * and serializes via WorkspaceResource. Mirrors gateway's loadMissing chain.
   */
  private async hydrateWorkspace(workspaceId: bigint): Promise<any> {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) return null;

    const [branding, creator, allDomains] = await Promise.all([
      this.prisma.brandings.findFirst({
        where: {
          brandable_id: workspaceId,
          brandable_type: 'App\\Models\\Workspace',
        },
      }),
      workspace.creator_id
        ? this.prisma.users.findUnique({
            where: { id: workspace.creator_id },
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

    const active_domain = allDomains.find((d) => d.active && !d.is_default);
    const system_domain = allDomains.find((d) => d.is_default);

    return WorkspaceResource.toJSON({
      workspace,
      branding,
      creator,
      active_domain,
      system_domain,
      domains: allDomains,
    });
  }

  // ─── Agency Branding (Gateway parity: BillingController::agencyBranding) ──

  /**
   * GET — return agency branding addon name + price.
   * Mirrors BillingController::agencyBranding GET branch.
   */
  async getAgencyBrandingInfo(agencyId: bigint): Promise<any> {
    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (!subscription) throw new BadRequestException('No active subscription');

    const itemId = process.env.BILLING_AGENCY_BRANDING_ADDON;
    if (!itemId)
      throw new BadRequestException('Agency branding addon not configured');

    const addon = await this.prisma.billing_addons.findFirst({
      where: { item_id: itemId },
    });
    if (!addon) throw new NotFoundException('Branding addon not found');

    const price = await this.prisma.billing_item_prices.findFirst({
      where: {
        itemable_id: addon.id,
        itemable_type: 'App\\Models\\BillingAddon',
        currency_code: 'USD',
      },
    });
    if (!price) throw new NotFoundException('Branding price not found');

    return {
      addon: {
        name: addon.external_name,
        price: (price.price || 0) / 100,
      },
    };
  }

  /**
   * POST — charge Chargebee for agency branding + set branding_enabled=true.
   */
  async enableAgencyBranding(agencyId: bigint, userId: bigint): Promise<any> {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (!subscription) throw new BadRequestException('No active subscription');

    const itemId = process.env.BILLING_AGENCY_BRANDING_ADDON;
    if (!itemId)
      throw new BadRequestException('Agency branding addon not configured');

    const addon = await this.prisma.billing_addons.findFirst({
      where: { item_id: itemId },
    });
    const price =
      addon &&
      (await this.prisma.billing_item_prices.findFirst({
        where: {
          itemable_id: addon.id,
          itemable_type: 'App\\Models\\BillingAddon',
          currency_code: 'USD',
        },
      }));
    if (!price)
      throw new NotFoundException('Agency branding price not configured');

    try {
      await this.chargebee.updateSubscriptionForItems(
        subscription.subscription_id,
        {
          subscription_items: [
            { item_price_id: price.price_id, quantity: 1 },
          ],
        },
      );
    } catch (err) {
      throw new BadRequestException(`Payment failed: ${err.message}`);
    }

    await this.prisma.agencies.update({
      where: { id: agencyId },
      data: { branding_enabled: true },
    });

    // Fire event so OnAgencyUpdatedListener handles cache + audit
    this.eventEmitter.emit(
      AgencyUpdatedEvent.NAME,
      new AgencyUpdatedEvent(agencyId, { branding_enabled: true }, userId),
    );

    return { success: true, agency_id: agencyId.toString() };
  }

  /**
   * DELETE — set branding_enabled=false + recompute subscription items.
   * The OnAgencyUpdated listener handles cleanup (logos, custom domain delete).
   */
  async disableAgencyBranding(
    agencyId: bigint,
    userId: bigint,
  ): Promise<any> {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    await this.prisma.agencies.update({
      where: { id: agencyId },
      data: { branding_enabled: false },
    });

    // Fire event — listener handles cleanup (logos, custom domain, cache, audit)
    this.eventEmitter.emit(
      AgencyUpdatedEvent.NAME,
      new AgencyUpdatedEvent(agencyId, { branding_enabled: false }, userId),
    );

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (subscription) {
      await this.recompute.recompute(subscription.id);
    }

    return { success: true, agency_id: agencyId.toString() };
  }

  // ─── Workspace Branding (Gateway parity: enableBranding/disableBranding) ───

  /**
   * GET /enable-branding equivalent — returns Chargebee estimation for adding
   * one more branded workspace. Plan free_workspace_branding=true → no charge.
   */
  async estimateBrandingForWorkspace(
    agencyId: bigint,
    workspaceId: bigint,
  ): Promise<any> {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (!subscription) throw new BadRequestException('No active subscription');

    const plan = subscription.billing_plan_id
      ? await this.prisma.billing_plans.findUnique({
          where: { id: subscription.billing_plan_id },
        })
      : null;
    if (!plan) throw new BadRequestException('Plan not found');

    const totalBrandings =
      (await this.prisma.workspaces.count({
        where: { agency_id: agencyId, allow_branding: true, deleted_at: null },
      })) + 1;

    const brandingAddon = await this.prisma.billing_addons.findFirst({
      where: { name: process.env.BILLING_BRANDING_ADDON },
    });
    if (!brandingAddon)
      throw new BadRequestException('Branding addon not configured');

    const brandingPrice = await this.prisma.billing_item_prices.findFirst({
      where: {
        itemable_id: brandingAddon.id,
        itemable_type: 'App\\Models\\BillingAddon',
        currency_code: 'USD',
      },
    });
    if (!brandingPrice)
      throw new BadRequestException('Branding price not found');

    const estimation: any = {
      line_items: {
        [brandingPrice.price_id]: {
          entity_id: brandingPrice.price_id,
          addon_id: brandingAddon.id.toString(),
          unit_amount: (brandingPrice.price || 0) / 100,
          amount: 0,
          discount_amount: 0,
          description: brandingAddon.name,
          currency_code: 'USD',
        },
      },
      sub_total: 0,
      discount: 0,
      total: 0,
      currency_code: 'USD',
    };

    if (!plan.free_workspace_branding) {
      try {
        const estimate = await this.chargebee.estimateUpdateSubscriptionForItems({
          invoice_immediately: false,
          subscription: { id: subscription.subscription_id },
          prorate: true,
          subscription_items: [
            {
              item_price_id: brandingPrice.price_id,
              quantity: totalBrandings,
              proration_type: 'partial_term',
            },
          ],
        });

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
      } catch (err) {
        this.logger.error(`Branding estimation failed: ${err.message}`);
        throw new BadRequestException(`Estimation failed: ${err.message}`);
      }
    }

    return { estimate: estimation };
  }

  /**
   * POST /enable-branding equivalent — charges Chargebee (if not free in plan)
   * and sets workspace.allow_branding = true.
   */
  async enableBrandingForWorkspace(
    agencyId: bigint,
    workspaceId: bigint,
    userId: bigint,
  ): Promise<any> {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (!subscription) throw new BadRequestException('No active subscription');

    const plan = subscription.billing_plan_id
      ? await this.prisma.billing_plans.findUnique({
          where: { id: subscription.billing_plan_id },
        })
      : null;
    if (!plan) throw new BadRequestException('Plan not found');

    if (!plan.free_workspace_branding) {
      const totalBrandings =
        (await this.prisma.workspaces.count({
          where: {
            agency_id: agencyId,
            allow_branding: true,
            deleted_at: null,
          },
        })) + 1;

      const brandingAddon = await this.prisma.billing_addons.findFirst({
        where: { name: process.env.BILLING_BRANDING_ADDON },
      });
      const brandingPrice =
        brandingAddon &&
        (await this.prisma.billing_item_prices.findFirst({
          where: {
            itemable_id: brandingAddon.id,
            itemable_type: 'App\\Models\\BillingAddon',
            currency_code: 'USD',
          },
        }));
      if (!brandingPrice)
        throw new BadRequestException('Branding price not found');

      try {
        await this.chargebee.updateSubscriptionForItems(
          subscription.subscription_id,
          {
            prorate: true,
            invoice_immediately: true,
            subscription_items: [
              {
                item_price_id: brandingPrice.price_id,
                quantity: totalBrandings,
              },
            ],
          },
        );
      } catch (err) {
        this.logger.error(`Branding charge failed: ${err.message}`);
        throw new BadRequestException(`Payment failed: ${err.message}`);
      }
    }

    await this.prisma.workspaces.update({
      where: { id: workspaceId },
      data: { allow_branding: true },
    });

    await this.prisma.audit_logs.create({
      data: {
        workspace_id: workspaceId,
        event: 'white_label_purchased',
        user_id: userId,
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace',
        data: JSON.stringify({ workspace_name: workspace.name }),
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { workspace: await this.hydrateWorkspace(workspaceId) };
  }

  /**
   * disableBranding equivalent — deletes custom domain via Entri,
   * unsets allow_branding, logs both domain_removed + white_label_cancelled.
   */
  async disableBrandingForWorkspace(
    agencyId: bigint,
    workspaceId: bigint,
    userId: bigint,
  ): Promise<any> {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const domain = await this.prisma.domains.findFirst({
      where: {
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace',
        is_default: false,
      },
    });

    if (domain) {
      try {
        await this.entri.deletePowerDomain(
          `${domain.sub_domain}.${domain.root_domain}`,
        );
      } catch (err) {
        this.logger.warn(
          `Entri delete failed (continuing): ${err.message}`,
        );
      }

      await this.prisma.$transaction([
        this.prisma.domains.updateMany({
          where: {
            modelable_id: workspaceId,
            modelable_type: 'App\\Models\\Workspace',
            is_default: true,
          },
          data: { active: true },
        }),
        this.prisma.domains.delete({ where: { id: domain.id } }),
      ]);

      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          event: 'domain_removed',
          user_id: userId,
          modelable_id: domain.id,
          modelable_type: 'App\\Models\\Domain',
          data: JSON.stringify({
            domain: domain.domain,
            note: 'Disabled the branding by agency',
          }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });

      // Invalidate Redis cache so future requests don't resolve to dead domain
      const host = (domain.domain || '').replace(/^https?:\/\//, '');
      if (host) await this.domainCache.invalidate(host);
    }

    await this.prisma.workspaces.update({
      where: { id: workspaceId },
      data: { allow_branding: false },
    });

    // Clean up workspace branding row + media files
    const wsBranding = await this.prisma.brandings.findFirst({
      where: {
        brandable_id: workspaceId,
        brandable_type: 'App\\Models\\Workspace',
      },
    });
    if (wsBranding) {
      const mediaIds = [
        wsBranding.favicon_media_id,
        wsBranding.mid_logo_light,
        wsBranding.mid_logo_light_small,
        wsBranding.mid_logo_dark,
        wsBranding.mid_logo_dark_small,
      ];
      await this.prisma.brandings.update({
        where: { id: wsBranding.id },
        data: {
          color: null,
          selection_color: null,
          link_color: null,
          incoming_chat_color: null,
          outgoing_chat_color: null,
          favicon_media_id: null,
          mid_logo_light: null,
          mid_logo_light_small: null,
          mid_logo_dark: null,
          mid_logo_dark_small: null,
        },
      });
      // Delete orphan media (best-effort, doesn't fail flow)
      try {
        const fullMedia = await this.prisma.media_gallery.findMany({
          where: { id: { in: mediaIds.filter((id): id is bigint => !!id) } },
        });
        const fs = require('fs');
        const path = require('path');
        const uploadPath = path.join(process.cwd(), 'uploads');
        for (const m of fullMedia) {
          if (m.file_path) {
            const fp = path.join(uploadPath, m.file_path);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
          }
        }
        await this.prisma.media_gallery.deleteMany({
          where: { id: { in: mediaIds.filter((id): id is bigint => !!id) } },
        });
      } catch (err) {
        this.logger.warn(`Workspace branding media cleanup failed: ${err.message}`);
      }
    }

    await this.prisma.audit_logs.create({
      data: {
        workspace_id: workspaceId,
        event: 'white_label_cancelled',
        user_id: userId,
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace',
        data: JSON.stringify({ workspace_name: workspace.name }),
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Recompute subscription quantities so Chargebee never has stale qty
    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });
    if (subscription) {
      await this.recompute.recompute(subscription.id);
    }

    return { workspace: await this.hydrateWorkspace(workspaceId) };
  }

  /**
   * Estimate the cost of enabling white-label for a workspace
   */
  async estimateWhiteLabelCost(workspaceId: bigint): Promise<any> {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.allow_branding) {
      throw new BadRequestException('White-label is already enabled for this workspace');
    }

    // Get agency and subscription
    const agency = await this.prisma.agencies.findUnique({
      where: { id: workspace.agency_id },
    });

    if (!agency) {
      throw new NotFoundException('Agency not found');
    }

    if (!agency.customer_id) {
      throw new BadRequestException('Agency has no Chargebee customer');
    }

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: {
        agency_id: agency.id,
        deleted_at: null,
      },
    });

    if (!subscription) {
      throw new BadRequestException('No active subscription found');
    }

    // Estimate cost for white-label addon
    const whitelabelPriceId = process.env.BILLING_WHITELABEL_ADDON_PRICE_ID;
    if (!whitelabelPriceId) {
      throw new BadRequestException('White-label pricing not configured');
    }

    try {
      const estimate = await this.chargebee.estimateUpdateSubscriptionForItems({
        subscription: { id: subscription.subscription_id },
        subscription_items: [
          {
            item_price_id: whitelabelPriceId,
            quantity: 1,
          },
        ],
        proration_type: 'partial_term',
      });

      this.logger.log(
        `White-label estimation for workspace ${workspaceId}: ${estimate?.estimate?.total || 0}`
      );

      return {
        success: true,
        estimation: estimate,
        message: 'Cost estimation calculated',
      };
    } catch (error) {
      this.logger.error(`Estimation failed: ${error.message}`);
      throw new BadRequestException(`Estimation failed: ${error.message}`);
    }
  }

  /**
   * Enable white-label for a workspace (charge customer)
   */
  async enableWhiteLabel(
    workspaceId: bigint,
    domain_data: {
      sub_domain: string;
      root_domain: string;
    },
    userId: bigint,
  ): Promise<any> {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.allow_branding) {
      throw new BadRequestException(
        'White-label is already enabled for this workspace'
      );
    }

    // Get agency and subscription
    const agency = await this.prisma.agencies.findUnique({
      where: { id: workspace.agency_id },
    });

    if (!agency) {
      throw new NotFoundException('Agency not found');
    }

    if (!agency.customer_id) {
      throw new BadRequestException('Agency has no Chargebee customer');
    }

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: {
        agency_id: agency.id,
        deleted_at: null,
      },
    });

    if (!subscription) {
      throw new BadRequestException('No active subscription found');
    }

    const whitelabelPriceId = process.env.BILLING_WHITELABEL_ADDON_PRICE_ID;
    if (!whitelabelPriceId) {
      throw new BadRequestException('White-label pricing not configured');
    }

    try {
      // Charge Chargebee
      this.logger.log(`Charging for white-label: subscription ${subscription.subscription_id}`);

      const update = await this.chargebee.updateSubscriptionForItems(
        subscription.subscription_id,
        {
          subscription_items: [
            {
              item_price_id: whitelabelPriceId,
              quantity: 1,
            },
          ],
          proration_type: 'partial_term',
        }
      );

      // Update workspace
      await this.prisma.workspaces.update({
        where: { id: workspaceId },
        data: { allow_branding: true },
      });

      // Create default domain for white-label
      const protocol = process.env.NODE_ENV === 'production' ? 'https://' : 'http://';
      const fullDomain = `${protocol}${domain_data.sub_domain}.${domain_data.root_domain}`;

      // Check if domain already exists
      let domain = await this.prisma.domains.findUnique({
        where: { domain: fullDomain },
      });

      if (!domain) {
        domain = await this.prisma.domains.create({
          data: {
            modelable_id: workspaceId,
            modelable_type: 'App\\Models\\Workspace',
            sub_domain: domain_data.sub_domain,
            root_domain: domain_data.root_domain,
            domain: fullDomain,
            is_default: false,
            active: true,
          },
        });

        // Deactivate other domains
        await this.prisma.domains.updateMany({
          where: {
            modelable_id: workspaceId,
            modelable_type: 'App\\Models\\Workspace',
            id: { not: domain.id },
          },
          data: { active: false },
        });
      }

      // Create audit log
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          event: 'white_label_purchased',
          user_id: userId,
          modelable_id: domain.id,
          modelable_type: 'App\\Models\\Domain',
          data: JSON.stringify({
            domain: domain.domain,
            chargebee_response: update,
          }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });

      this.logger.log(
        `White-label enabled for workspace ${workspaceId} with domain ${domain.domain}`
      );

      return {
        success: true,
        message: 'White-label enabled successfully',
        workspace: workspace,
        domain: domain,
      };
    } catch (error) {
      this.logger.error(`Enable white-label failed: ${error.message}`, error.stack);
      throw new BadRequestException(
        `Enable white-label failed: ${error.message}`
      );
    }
  }

  /**
   * Disable white-label for a workspace (refund customer)
   */
  async disableWhiteLabel(workspaceId: bigint, userId: bigint): Promise<any> {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (!workspace.allow_branding) {
      throw new BadRequestException(
        'White-label is not enabled for this workspace'
      );
    }

    // Get agency and subscription
    const agency = await this.prisma.agencies.findUnique({
      where: { id: workspace.agency_id },
    });

    if (!agency) {
      throw new NotFoundException('Agency not found');
    }

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: {
        agency_id: agency.id,
        deleted_at: null,
      },
    });

    if (!subscription) {
      throw new BadRequestException('No active subscription found');
    }

    const whitelabelPriceId = process.env.BILLING_WHITELABEL_ADDON_PRICE_ID;
    if (!whitelabelPriceId) {
      throw new BadRequestException('White-label pricing not configured');
    }

    try {
      // Remove white-label addon from subscription
      this.logger.log(`Removing white-label addon from subscription ${subscription.subscription_id}`);

      const update = await this.chargebee.updateSubscriptionForItems(
        subscription.subscription_id,
        {
          subscription_items: [
            {
              item_price_id: whitelabelPriceId,
              quantity: 0,
            },
          ],
          proration_type: 'partial_term',
        }
      );

      // Find and delete custom domain
      const domain = await this.prisma.domains.findFirst({
        where: {
          modelable_id: workspaceId,
          modelable_type: 'App\\Models\\Workspace',
          is_default: false,
          active: true,
        },
      });

      // Disable custom domain
      if (domain) {
        await this.prisma.domains.update({
          where: { id: domain.id },
          data: { active: false },
        });

        // Activate default domain
        await this.prisma.domains.updateMany({
          where: {
            modelable_id: workspaceId,
            modelable_type: 'App\\Models\\Workspace',
            is_default: true,
          },
          data: { active: true },
        });
      }

      // Update workspace
      await this.prisma.workspaces.update({
        where: { id: workspaceId },
        data: { allow_branding: false },
      });

      // Create audit log
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          event: 'white_label_cancelled',
          user_id: userId,
          modelable_id: domain?.id || 0n,
          modelable_type: 'App\\Models\\Domain',
          data: JSON.stringify({
            domain: domain?.domain || null,
            chargebee_response: update,
          }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });

      this.logger.log(`White-label disabled for workspace ${workspaceId}`);

      // Recompute subscription quantities post-cancellation
      await this.recompute.recompute(subscription.id);

      return {
        success: true,
        message: 'White-label disabled successfully',
        workspace: workspace,
      };
    } catch (error) {
      this.logger.error(`Disable white-label failed: ${error.message}`, error.stack);
      throw new BadRequestException(
        `Disable white-label failed: ${error.message}`
      );
    }
  }
}
