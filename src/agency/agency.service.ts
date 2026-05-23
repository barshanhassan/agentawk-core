import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChargebeeService } from '../billing/chargebee.service';
import { DomainsService } from '../domains/domains.service';
import * as bcrypt from 'bcrypt';

// Date-only strings (YYYY-MM-DD) need explicit start/end-of-day so a request
// like ?from=2026-05-21&to=2026-05-21 covers the full day, not just midnight.
function parseRangeStart(v: string): Date {
  const d = new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d.setHours(0, 0, 0, 0);
  return d;
}
function parseRangeEnd(v: string): Date {
  const d = new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d.setHours(23, 59, 59, 999);
  return d;
}

@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
    private readonly domainsService: DomainsService,
  ) { }

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

    // Resolve media URLs
    let logoUrl = '';
    let faviconUrl = '';
    if (branding) {
      if (branding.mid_logo_light) {
        const logo = await this.prisma.media_gallery.findUnique({ where: { id: branding.mid_logo_light } });
        logoUrl = logo?.file_url || '';
      }
      if (branding.favicon_media_id) {
        const fav = await this.prisma.media_gallery.findUnique({ where: { id: branding.favicon_media_id } });
        faviconUrl = fav?.file_url || '';
      }
    }

    return {
      success: true,
      agency: {
        ...this.serialize(agency),
        branding: branding ? {
          ...this.serialize(branding),
          logo: logoUrl,
          favicon: faviconUrl
        } : null,
        address: address ? this.serialize(address) : null
      }
    };
  }


  async updateAgency(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const updated = await this.prisma.agencies.update({
      where: { id: agencyId },
      data: {
        name: data.name,
        email: data.email,
        notification_email: data.notification_email,
        timezone: data.timezone,
        notification_language: data.notification_language,
        tax_id: data.tax_id,
        vat: data.vat,
        billing_company: data.billing_company,
        billing_person: data.billing_person,
      },
    });

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

    await this.logAgencyEvent(
      agencyId,
      'billing_address_updated',
      data.user_id ?? 0n,
      'App\\Models\\Agency',
      agencyId,
      { city: data.address?.city, country: data.address?.country_iso2 },
    );

    return { success: true };
  }

  async updateBranding(agencyId: bigint, data: any) {
    // 1. Fetch or create branding record
    let branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: agencyId, brandable_type: 'App\\Models\\Agency' }
    });

    if (!branding) {
      branding = await this.prisma.brandings.create({
        data: {
          brandable_id: agencyId,
          brandable_type: 'App\\Models\\Agency',
          color: data.color || '#149f8f',
        }
      });
    }

    const updateData: any = {};
    if (data.color !== undefined) updateData.color = data.color;

    // Helper to handle media URLs
    const getMediaId = async (url: string, objectName: string) => {
      if (!url) return null;
      // Check if media already exists for this agency and url
      let media = await this.prisma.media_gallery.findFirst({
        where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency', file_url: url }
      });

      if (!media) {
        media = await this.prisma.media_gallery.create({
          data: {
            modelable_id: agencyId,
            modelable_type: 'App\\Models\\Agency',
            file_url: url,
            object_name: objectName,
            media_type: 'IMAGE',
            object_status: 'AVAILABLE'
          }
        });
      }
      return media.id;
    };

    if (data.logo !== undefined) {
      const mediaId = await getMediaId(data.logo, 'Agency Logo');
      updateData.mid_logo_light = mediaId;
    }

    if (data.favicon !== undefined) {
      const mediaId = await getMediaId(data.favicon, 'Agency Favicon');
      updateData.favicon_media_id = mediaId;
    }

    const updatedBranding = await this.prisma.brandings.update({
      where: { id: branding.id },
      data: updateData,
    });

    // 3. Update Agency slug/domain if provided
    if (data.slug !== undefined) {
      await this.prisma.agencies.update({
        where: { id: agencyId },
        data: {
          slug: data.slug,
        }
      });
    }

    await this.logAgencyEvent(
      agencyId,
      'branding_updated',
      data.user_id ?? 0n,
      'App\\Models\\Agency',
      agencyId,
      { color: data.color },
    );

    return { success: true, branding: this.serialize(updatedBranding) };
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

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });

    if (!subscription || !subscription.billing_plan_id) throw new BadRequestException('Subscription or Plan not found');

    const plan = await this.prisma.billing_plans.findUnique({
      where: { id: subscription.billing_plan_id },
    });

    if (!plan) throw new BadRequestException('Plan not found');

    const totalWorkspaces = await this.prisma.workspaces.count({
      where: { agency_id: agencyId, deleted_at: null },
    });

    if (totalWorkspaces >= plan.maximum_workspaces) {
      throw new BadRequestException('Workspace limit reached');
    }

    // Estimation logic
    const subscriptionItems: any[] = [];
    const extraWorkspaces = totalWorkspaces + 1 - plan.free_workspaces;

    if (extraWorkspaces > 0) {
      // Assuming you have the Price ID for extra workspaces
      subscriptionItems.push({
        item_price_id: process.env.BILLING_WORKSPACE_ADDON_PRICE_ID,
        quantity: extraWorkspaces,
      });
    }

    try {
      const estimate = await this.chargebee.estimateUpdateSubscriptionForItems({
        subscription: { id: subscription.subscription_id },
        subscription_items: subscriptionItems,
      });
      return { success: true, estimate };
    } catch (err) {
      throw new BadRequestException(`Estimation failed: ${err.message}`);
    }
  }

  async createWorkspace(agencyId: bigint, data: any, creatorId: bigint) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });

    if (!agency) throw new NotFoundException('Agency not found');

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });

    const plan = subscription && subscription.billing_plan_id
      ? await this.prisma.billing_plans.findUnique({
        where: { id: subscription.billing_plan_id },
      })
      : null;

    const workspace = await this.prisma.$transaction(async (tx) => {
      // 1. Create Workspace
      const ws = await tx.workspaces.create({
        data: {
          name: data.name,
          slug: data.slug,
          agency_id: agencyId,
          creator_id: creatorId,
          agency_agent_id: data.agent_id ? BigInt(data.agent_id) : null,
          timezone: data.timezone || 'UTC',
          status: 'ACTIVE',
          created_at: new Date(),
          updated_at: new Date(),
          contacts_counter: 0,
          allow_branding: data.allow_branding ?? false,
          allow_support: data.allow_support ?? false,
          allow_agents: data.allow_agents ?? true,
          agents_limit: data.agents_limit ?? 4,
          limited_contacts: data.limited_contacts ?? false,
          maximum_contacts: data.maximum_contacts ?? 0,
          chatgpt_assistant_limit: data.chatgpt_assistant_limit ?? 10,
          whatsapp_channels_limit: data.whatsapp_channels_limit ?? 1,
          instagram_channels_limit: data.instagram_channels_limit ?? 1,
          facebook_channels_limit: data.facebook_channels_limit ?? 1,
          telegram_channels_limit: data.telegram_channels_limit ?? 1,
          twilio_channels_limit: data.twilio_channels_limit ?? 1,
          zapi_channels_limit: data.zapi_channels_limit ?? 0,
          webchat_channels_limit: data.webchat_channels_limit ?? 0,
        },
      });

      // 2. If an agency agent is assigned, mirror them as a workspace user row so they
      //    can later log in at the workspace's subdomain (login flow filters by
      //    modelable_id + modelable_type matching the host's site_domain).
      //    Pattern mirrors gateway: separate user row, agency_user_id cross-links back.
      if (data.agent_id) {
        const agentId = BigInt(data.agent_id);
        const agencyUser = await tx.users.findFirst({
          where: {
            id: agentId,
            modelable_type: 'App\\Models\\Agency',
            modelable_id: agencyId,
            status: 'ACTIVE',
          },
        });
        if (agencyUser) {
          const existing = await tx.users.findFirst({
            where: {
              modelable_type: 'App\\Models\\Workspace',
              modelable_id: ws.id,
              agency_user_id: agencyUser.id,
            },
          });
          if (!existing) {
            await tx.users.create({
              data: {
                first_name: agencyUser.first_name,
                last_name: agencyUser.last_name,
                full_name: agencyUser.full_name,
                email: agencyUser.email,
                password: agencyUser.password,
                modelable_type: 'App\\Models\\Workspace',
                modelable_id: ws.id,
                agency_user_id: agencyUser.id,
                is_owner: true,
                locale: agencyUser.locale,
                timezone: agencyUser.timezone,
                status: 'ACTIVE',
                creator_id: creatorId,
                created_at: new Date(),
                updated_at: new Date(),
              },
            });
          }
        }
      }

      // 3. Chargebee Sync (if needed)
      if (subscription && plan) {
        const totalWs = await tx.workspaces.count({
          where: { agency_id: agencyId, deleted_at: null },
        });
        const extra = totalWs - plan.free_workspaces;

        if (extra > 0) {
          await this.chargebee.updateSubscriptionForItems(
            subscription.subscription_id,
            {
              subscription_items: [
                {
                  item_price_id: process.env.BILLING_WORKSPACE_ADDON_PRICE_ID,
                  quantity: extra,
                },
              ],
            },
          );
        }
      }

      return ws;
    });

    // 3. Domain creation
    await this.domainsService.addCustomDomain(
      workspace.id,
      'WORKSPACE',
      data.slug,
      process.env.ACCOUNTS_DOMAIN || 'ezconn.io',
      creatorId,
    );

    await this.logAgencyEvent(agencyId, 'workspace_created', creatorId, 'App\\Models\\Workspace', workspace.id, {
      workspace_name: workspace.name,
    });

    return { success: true, workspace: this.serialize(workspace) };
  }

  async updateWorkspace(workspaceId: bigint, agencyId: bigint, data: any, actorId: bigint = 0n) {
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

    await this.logAgencyEvent(agencyId, 'workspace_updated', actorId, 'App\\Models\\Workspace', workspaceId, {
      workspace_name: updated.name,
    });

    return { success: true, workspace: this.serialize(updated) };
  }

  async suspendWorkspace(workspaceId: bigint, agencyId: bigint, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
      select: { name: true },
    });
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { status: 'SUSPENDED' },
    });
    if (updated.count > 0) {
      await this.logAgencyEvent(agencyId, 'workspace_suspended', actorId, 'App\\Models\\Workspace', workspaceId, {
        workspace_name: workspace?.name,
      });
    }
    return { success: updated.count > 0 };
  }

  async activateWorkspace(workspaceId: bigint, agencyId: bigint, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
      select: { name: true },
    });
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { status: 'ACTIVE' },
    });
    if (updated.count > 0) {
      await this.logAgencyEvent(agencyId, 'workspace_activated', actorId, 'App\\Models\\Workspace', workspaceId, {
        workspace_name: workspace?.name,
      });
    }
    return { success: updated.count > 0 };
  }

  async deleteWorkspace(workspaceId: bigint, agencyId: bigint, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
      select: { name: true },
    });
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { deleted_at: new Date() },
    });
    if (updated.count > 0) {
      await this.logAgencyEvent(agencyId, 'workspace_deleted', actorId, 'App\\Models\\Workspace', workspaceId, {
        workspace_name: workspace?.name,
      });
    }
    return { success: updated.count > 0 };
  }

  async getWorkspaceUsage(workspaceId: bigint, agencyId: bigint) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // This is a placeholder for actual usage calculation logic
    // In a real scenario, you'd aggregate data from various tables (messages, agents, etc.)
    return {
      success: true,
      usage: {
        contacts: workspace.contacts_counter || 0,
        agents: 0, // Placeholder
        messages: 0, // Placeholder
      }
    };
  }

  // ─── Member Management ──────────────────────────────────────────────

  async members(agencyId: bigint) {
    const users = await this.prisma.users.findMany({
      where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      // Keep the agency owner pinned at the top, then newest users first so a
      // freshly added member appears right under the owner. Order by id (PK,
      // never null) rather than created_at which can be null on migrated rows.
      orderBy: [{ is_owner: 'desc' }, { id: 'desc' }],
    });

    // Attach actual role name from acl_roleables → acl_roles
    const enriched = await Promise.all(users.map(async (u) => {
      const roleable = await this.prisma.acl_roleables.findFirst({
        where: { roleable_id: u.id, roleable_type: 'App\\Models\\User' },
      });
      let roleName = 'Agent';
      if (roleable) {
        const role = await this.prisma.acl_roles.findUnique({ where: { id: BigInt(roleable.role_id) } });
        if (role) roleName = role.name;
      }
      return { ...u, role: roleName };
    }));

    return { success: true, members: this.serialize(enriched) };
  }


  async getMember(agencyId: bigint, memberId: bigint) {
    const user = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    if (!user) throw new NotFoundException('Member not found');

    return { success: true, member: this.serialize(user) };
  }

  async updateMember(agencyId: bigint, memberId: bigint, data: any, actorId: bigint = 0n) {
    const user = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    if (!user) throw new NotFoundException('Member not found');

    // Only set columns that exist on the users table. phone/whatsapp are not
    // user columns, and the form's "language" maps to the `locale` column
    // (mirrors addMember). Skip undefined fields so partial updates are safe.
    const updateData: any = {
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      updated_at: new Date(),
    };
    if (data.language) updateData.locale = data.language;
    if (data.status) updateData.status = data.status;
    if (typeof data.tfa_required !== 'undefined') updateData.tfa_required = !!data.tfa_required;
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    const updated = await this.prisma.users.update({
      where: { id: memberId },
      data: updateData,
    });

    // Re-sync the role assignment when a role slug is provided (Edit form has a
    // role dropdown). Upsert keeps the single roleable row per user in sync.
    if (data.role) {
      const role = await this.prisma.acl_roles.findFirst({
        where: {
          slug: data.role.toLowerCase().replace(/_/g, '-'),
          ownerable_id: agencyId,
          ownerable_type: 'App\\Models\\Agency',
        },
      });
      if (role) {
        // acl_roleables has only an index (not a unique constraint) on
        // (roleable_type, roleable_id), so upsert-by-compound-key isn't valid.
        // Clear any existing role link for this user, then create the new one —
        // guarantees a single, clean role assignment.
        await this.prisma.acl_roleables.deleteMany({
          where: { roleable_id: memberId, roleable_type: 'App\\Models\\User' },
        });
        await this.prisma.acl_roleables.create({
          data: {
            role_id: Number(role.id),
            roleable_id: memberId,
            roleable_type: 'App\\Models\\User',
          },
        });
      }
    }

    await this.logAgencyEvent(agencyId, 'user_updated', actorId, 'App\\Models\\User', memberId, {
      name: `${data.first_name ?? user.first_name ?? ''} ${data.last_name ?? user.last_name ?? ''}`.trim() || user.email,
      email: user.email,
    });

    return { success: true, member: this.serialize(updated) };
  }

  async removeMember(agencyId: bigint, memberId: bigint, actorId: bigint = 0n) {
    // Capture identity before deletion so the log can show who was removed.
    const target = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      select: { first_name: true, last_name: true, email: true },
    });

    const deleted = await this.prisma.users.deleteMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });

    if (deleted.count > 0) {
      await this.logAgencyEvent(agencyId, 'user_deleted', actorId, 'App\\Models\\User', memberId, {
        name: `${target?.first_name ?? ''} ${target?.last_name ?? ''}`.trim() || target?.email,
        email: target?.email,
      });
    }

    return { success: deleted.count > 0 };
  }

  async suspendMember(agencyId: bigint, memberId: bigint, actorId: bigint = 0n) {
    const target = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      select: { first_name: true, last_name: true, email: true },
    });
    const updated = await this.prisma.users.updateMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      data: { status: 'SUSPENDED', updated_at: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Member not found in this agency');
    await this.logAgencyEvent(agencyId, 'user_suspended', actorId, 'App\\Models\\User', memberId, {
      name: `${target?.first_name ?? ''} ${target?.last_name ?? ''}`.trim() || target?.email,
      email: target?.email,
    });
    return { success: true };
  }

  async activateMember(agencyId: bigint, memberId: bigint, actorId: bigint = 0n) {
    const target = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      select: { first_name: true, last_name: true, email: true },
    });
    const updated = await this.prisma.users.updateMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      data: { status: 'ACTIVE', updated_at: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Member not found in this agency');
    await this.logAgencyEvent(agencyId, 'user_activated', actorId, 'App\\Models\\User', memberId, {
      name: `${target?.first_name ?? ''} ${target?.last_name ?? ''}`.trim() || target?.email,
      email: target?.email,
    });
    return { success: true };
  }

  /**
   * Dashboard stats — scoped per user.
   *  - Agency owner (is_owner=true OR has agency.* wildcard) sees agency-wide totals.
   *  - Role-limited agent sees ONLY what they personally created: workspaces
   *    they're the creator/agency_agent of, and users they created. Each new
   *    agent therefore lands on a "0 / 0" dashboard until they actually create
   *    resources, matching the request that counts reflect the logged-in agent.
   */
  async getDashboardStats(agencyId: bigint, user?: any) {
    const userId = BigInt(user?.sub ?? user?.id ?? 0);
    const perms: string[] = Array.isArray(user?.permissions) ? user.permissions : [];
    const isOwner = user?.is_owner === true || perms.includes('agency.*') || perms.includes('*');

    const workspaceWhere: any = isOwner
      ? { agency_id: agencyId, deleted_at: null }
      : {
          agency_id: agencyId,
          deleted_at: null,
          OR: [{ creator_id: userId }, { agency_agent_id: userId }],
        };

    const userWhere: any = isOwner
      ? { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' }
      : {
          modelable_id: agencyId,
          modelable_type: 'App\\Models\\Agency',
          creator_id: userId,
        };

    const recentLogsWhere: any = isOwner
      ? { agency_id: agencyId }
      : { agency_id: agencyId, user_id: userId };

    const [totalWorkspaces, totalAgents, recentLogs] = await Promise.all([
      this.prisma.workspaces.count({ where: workspaceWhere }),
      this.prisma.users.count({ where: userWhere }),
      this.prisma.agency_logs.findMany({
        where: recentLogsWhere,
        take: 5,
        orderBy: { created_at: 'desc' },
      }),
    ]);

    // agency_logs has no Prisma relation to users, so batch-fetch the actors to
    // show real names in the recent-activity feed instead of a generic "System".
    const logUserIds = Array.from(
      new Set((recentLogs as any[]).filter(l => l.user_id != null).map(l => l.user_id)),
    ) as bigint[];
    const logUsers = logUserIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: logUserIds } },
          select: { id: true, first_name: true, last_name: true, email: true },
        })
      : [];
    const logUserById = new Map(logUsers.map((u: any) => [u.id.toString(), u]));

    return {
      success: true,
      stats: {
        total_workspaces: totalWorkspaces,
        total_agents: totalAgents,
        premium_support_seats: "0 of 5", // Still hardcoded as per business logic usually
      },
      recent_activity: (recentLogs as any[]).map(log => {
        const u = log.user_id ? logUserById.get(log.user_id.toString()) : null;
        const name = u
          ? (`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email)
          : 'System';
        const initials = u
          ? (`${u.first_name?.[0] ?? ''}${u.last_name?.[0] ?? ''}`.toUpperCase()
              || (u.email?.[0]?.toUpperCase() ?? 'S'))
          : 'S';
        return {
          name,
          action: log.event.replace(/_/g, ' '),
          target: log.modelable_type?.split('\\').pop() || 'System',
          time: log.created_at,
          initials,
        };
      }),
    };
  }

  /**
   * Workspace-level audit logs (audit_logs table) with user hydration and
   * pagination. Optional filters: workspace_id (specific WS), event (slug),
   * date range, user_id, page/per_page.
   */
  async getAuditLogs(agencyId: bigint, q: any = {}) {
    const where: any = {};
    // Restrict to workspaces of this agency
    const wsIds = (
      await this.prisma.workspaces.findMany({
        where: { agency_id: agencyId, deleted_at: null },
        select: { id: true },
      })
    ).map((w) => w.id);

    if (wsIds.length === 0) {
      return { success: true, logs: [], total: 0, page: 1, per_page: 20 };
    }

    where.workspace_id = q.workspace_id ? BigInt(q.workspace_id) : { in: wsIds };
    if (q.event) where.event = q.event;
    if (q.user_id) where.user_id = BigInt(q.user_id);
    if (q.from || q.to) {
      where.created_at = {} as any;
      if (q.from) (where.created_at as any).gte = parseRangeStart(q.from);
      if (q.to) (where.created_at as any).lte = parseRangeEnd(q.to);
    }

    const perPage = Math.min(parseInt(q.per_page ?? '20', 10), 200);
    const page = Math.max(parseInt(q.page ?? '1', 10), 1);

    const [rows, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: perPage,
        skip: (page - 1) * perPage,
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    return { success: true, logs: await this.hydrateLogs(rows), total, page, per_page: perPage };
  }

  /**
   * Agency-level activity (agency_logs). Same shape as getAuditLogs but
   * scoped to this agency only.
   */
  async getAgencyLogs(agencyId: bigint, q: any = {}) {
    const where: any = { agency_id: agencyId };
    if (q.event) where.event = q.event;
    if (q.user_id) where.user_id = BigInt(q.user_id);
    if (q.from || q.to) {
      where.created_at = {} as any;
      if (q.from) (where.created_at as any).gte = parseRangeStart(q.from);
      if (q.to) (where.created_at as any).lte = parseRangeEnd(q.to);
    }

    const perPage = Math.min(parseInt(q.per_page ?? '20', 10), 200);
    const page = Math.max(parseInt(q.page ?? '1', 10), 1);

    const [rows, total] = await Promise.all([
      this.prisma.agency_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: perPage,
        skip: (page - 1) * perPage,
      }),
      this.prisma.agency_logs.count({ where }),
    ]);

    return { success: true, logs: await this.hydrateLogs(rows), total, page, per_page: perPage };
  }

  /**
   * Joins user details onto raw log rows (Prisma relations aren't defined for
   * audit_logs/agency_logs in this schema, so we batch-fetch users by id).
   * Returns serialized logs with `user`, `action`, `target` derived for UI.
   */
  private async hydrateLogs(rows: any[]) {
    // Batch-fetch users + workspaces because the underlying tables don't have
    // Prisma relations declared. One round-trip per entity type, then map back.
    const userIds = Array.from(
      new Set(rows.filter((r) => r.user_id != null).map((r) => r.user_id)),
    ) as bigint[];
    const wsIds = Array.from(
      new Set(rows.filter((r) => r.workspace_id != null && r.workspace_id !== 0n).map((r) => r.workspace_id)),
    ) as bigint[];

    const [users, workspaces] = await Promise.all([
      userIds.length
        ? this.prisma.users.findMany({
            where: { id: { in: userIds } },
            select: { id: true, first_name: true, last_name: true, email: true },
          })
        : Promise.resolve([] as any[]),
      wsIds.length
        ? this.prisma.workspaces.findMany({
            where: { id: { in: wsIds } },
            select: { id: true, name: true, slug: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const userById = new Map(users.map((u: any) => [u.id.toString(), u]));
    const wsById = new Map(workspaces.map((w: any) => [w.id.toString(), w]));

    return rows.map((r) => {
      const u = r.user_id ? userById.get(r.user_id.toString()) : null;
      const w = r.workspace_id ? wsById.get(r.workspace_id.toString()) : null;
      return {
        id: r.id?.toString(),
        agency_id: r.agency_id?.toString(),
        workspace_id: r.workspace_id?.toString(),
        workspace: w
          ? { id: w.id.toString(), name: w.name, slug: w.slug }
          : null,
        event: r.event,
        action: (r.event ?? '').replace(/_/g, ' '),
        target: r.modelable_type?.split('\\').pop() ?? null,
        modelable_id: r.modelable_id?.toString(),
        data: r.data,
        created_at: r.created_at,
        user: u
          ? {
              id: u.id.toString(),
              name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email,
              email: u.email,
            }
          : null,
      };
    });
  }

  async addMember(agencyId: bigint, data: any, actorId: bigint = 0n) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await this.prisma.users.create({
      data: {
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        password: hashedPassword,
        locale: data.language || 'en',
        modelable_id: agencyId,
        modelable_type: 'App\\Models\\Agency',
        status: 'ACTIVE',
        creator_id: actorId,
        tfa_required: !!data.tfa_required,
      },
    });

    await this.logAgencyEvent(agencyId, 'user_created', actorId, 'App\\Models\\User', user.id, {
      name: `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim() || data.email,
      email: data.email,
    });

    // Handle Role Assignment
    if (data.role) {
      const role = await this.prisma.acl_roles.findFirst({
        where: {
          slug: data.role.toLowerCase().replace(/_/g, '-'),
          ownerable_id: agencyId,
          ownerable_type: 'App\\Models\\Agency'
        }
      });

      if (role) {
        await this.prisma.acl_roleables.create({
          data: {
            role_id: Number(role.id),
            roleable_id: user.id,
            roleable_type: 'App\\Models\\User'
          }
        });
      }
    }

    return { success: true, user: this.serialize(user) };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  // Public so controllers can log events for actions handled by other services
  // (e.g. role create/update/delete go through RolesService).
  //
  // Logging must NEVER break the actual operation — it's a side-effect, always
  // the last step. So a failed log-write is caught and warned, not thrown.
  async logAgencyEvent(
    agencyId: bigint,
    event: string,
    userId: bigint,
    modelableType?: string,
    modelableId?: bigint,
    data?: any,
  ) {
    try {
      await this.prisma.agency_logs.create({
        data: {
          agency_id: agencyId,
          event: event,
          user_id: userId,
          modelable_type: modelableType,
          modelable_id: modelableId,
          data: data ? JSON.stringify(data) : null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to write agency_log "${event}" for agency ${agencyId}: ${err?.message}`,
      );
    }
  }

  private serialize(obj: any) {
    return JSON.parse(
      JSON.stringify(obj, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
