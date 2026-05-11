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

@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
    private readonly domainsService: DomainsService,
  ) {}

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
          timezone: data.timezone || 'UTC',
          status: 'ACTIVE',
          contacts_counter: 0,
        },
      });

      // 2. Chargebee Sync (if needed)
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
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { status: 'SUSPENDED' },
    });
    return { success: updated.count > 0 };
  }

  async activateWorkspace(workspaceId: bigint, agencyId: bigint) {
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { status: 'ACTIVE' },
    });
    return { success: updated.count > 0 };
  }

  async deleteWorkspace(workspaceId: bigint, agencyId: bigint) {
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { deleted_at: new Date() },
    });
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

  async updateMember(agencyId: bigint, memberId: bigint, data: any) {
    const user = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    if (!user) throw new NotFoundException('Member not found');

    const updateData: any = {
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      phone: data.phone,
      whatsapp: data.whatsapp,
      language: data.language,
      status: data.status,
    };

    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    const updated = await this.prisma.users.update({
      where: { id: memberId },
      data: updateData,
    });

    return { success: true, member: this.serialize(updated) };
  }

  async removeMember(agencyId: bigint, memberId: bigint) {
    const deleted = await this.prisma.users.deleteMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    return { success: deleted.count > 0 };
  }

  async getDashboardStats(agencyId: bigint) {
    const [totalWorkspaces, totalAgents, recentLogs] = await Promise.all([
      this.prisma.workspaces.count({ where: { agency_id: agencyId, deleted_at: null } }),
      this.prisma.users.count({ where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' } }),
      this.prisma.agency_logs.findMany({
        where: { agency_id: agencyId },
        take: 5,
        orderBy: { created_at: 'desc' },
      })
    ]);

    return {
      success: true,
      stats: {
        total_workspaces: totalWorkspaces,
        total_agents: totalAgents,
        premium_support_seats: "0 of 5", // Still hardcoded as per business logic usually
      },
      recent_activity: (recentLogs as any[]).map(log => ({
        name: log.user ? `${log.user.first_name} ${log.user.last_name}` : 'System',
        action: log.event.replace(/_/g, ' '),
        target: log.modelable_type?.split('\\').pop() || 'System',
        time: log.created_at,
        initials: log.user ? `${log.user.first_name?.[0] || ''}${log.user.last_name?.[0] || ''}` : 'S'
      }))
    };
  }

  async getAuditLogs(workspaceId: bigint) {
    const logs = await this.prisma.audit_logs.findMany({
      where: { workspace_id: workspaceId },
      take: 50,
      orderBy: { created_at: 'desc' },
    });
    return { success: true, logs: this.serialize(logs) };
  }

  async getAgencyLogs(agencyId: bigint) {
    const logs = await this.prisma.agency_logs.findMany({
      where: { agency_id: agencyId },
      take: 50,
      orderBy: { created_at: 'desc' },
    });
    return { success: true, logs: this.serialize(logs) };
  }

  async addMember(agencyId: bigint, data: any) {
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
        creator_id: 0n,
        tfa_required: !!data.tfa_required,
      },
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
      JSON.stringify(obj, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
