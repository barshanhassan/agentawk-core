// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /** S3 key → 1h signed URL (pass-through for absolute URLs / empty). */
  private async toDisplayUrl(value: string | null | undefined): Promise<string> {
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    const signed = await this.s3.getSignedUrl(value, 3600);
    return signed || '';
  }

  /**
   * Workspaces the logged-in user can switch to (mirrors replyagent's
   * getUserWorkspaces):
   *   - Agency owner  → every active workspace in the agency.
   *   - Other agent   → only workspaces they're a member of (cross-link rows
   *                     linked by agency_user_id).
   * Each result carries its sub_domain so the client switches by navigating to
   * that workspace's subdomain. The agency-owner flag is read from the linked
   * agency user — NOT the cross-link row (that row is always is_owner=true).
   */
  async getAccessibleWorkspaces(reqUser: any) {
    const me = await this.prisma.users.findUnique({
      where: { id: BigInt(reqUser.id) },
    });
    if (!me) return { success: true, workspaces: [] };

    let agencyId: bigint | null = null;
    let agencyAgentId: bigint = me.id;
    let isAgencyOwner = false;

    if (me.modelable_type === 'App\\Models\\Agency') {
      agencyId = me.modelable_id;
      agencyAgentId = me.id;
      isAgencyOwner = !!me.is_owner;
    } else if (me.modelable_type === 'App\\Models\\Workspace') {
      const ws = await this.prisma.workspaces.findUnique({
        where: { id: me.modelable_id },
      });
      agencyId = ws?.agency_id ?? null;
      agencyAgentId = me.agency_user_id ?? me.id;
      if (me.agency_user_id) {
        const agencyAgent = await this.prisma.users.findUnique({
          where: { id: me.agency_user_id },
        });
        isAgencyOwner = !!agencyAgent?.is_owner;
      }
    }

    if (!agencyId) return { success: true, workspaces: [] };

    let wsList;
    if (isAgencyOwner) {
      wsList = await this.prisma.workspaces.findMany({
        where: { agency_id: agencyId, deleted_at: null, status: 'ACTIVE' },
        orderBy: { created_at: 'desc' },
      });
    } else {
      const memberRows = await this.prisma.users.findMany({
        where: {
          modelable_type: 'App\\Models\\Workspace',
          agency_user_id: agencyAgentId,
        },
        select: { modelable_id: true },
      });
      const ids = [...new Set(memberRows.map((r) => r.modelable_id))];
      wsList = ids.length
        ? await this.prisma.workspaces.findMany({
            where: { id: { in: ids }, agency_id: agencyId, deleted_at: null, status: 'ACTIVE' },
            orderBy: { created_at: 'desc' },
          })
        : [];
    }

    // Attach each workspace's domain (prefer the active one) for switching.
    const ids = wsList.map((w) => w.id);
    const domains = ids.length
      ? await this.prisma.domains.findMany({
          where: { modelable_type: 'App\\Models\\Workspace', modelable_id: { in: ids } },
        })
      : [];
    const domainByWs = new Map<string, any>();
    for (const d of domains) {
      const key = String(d.modelable_id);
      if (!domainByWs.has(key) || d.active) domainByWs.set(key, d);
    }

    return {
      success: true,
      workspaces: wsList.map((w) => {
        const d = domainByWs.get(String(w.id));
        return {
          id: w.id.toString(),
          name: w.name,
          slug: w.slug,
          sub_domain: d?.sub_domain ?? w.slug,
          domain: d?.domain ?? null,
        };
      }),
    };
  }

  /**
   * Get detailed workspace info including creator and status
   */
  async getWorkspace(workspaceId: bigint) {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }

  /**
   * Update workspace settings (Naming, Branding, Limits)
   */
  async updateWorkspace(workspaceId: bigint, data: any) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.timezone !== undefined) updateData.timezone = data.timezone;
    if (data.firstDayOfWeek !== undefined) updateData.first_day_week = data.firstDayOfWeek.toUpperCase();

    return this.prisma.workspaces.update({
      where: { id: workspaceId },
      data: updateData,
    });
  }

  /**
   * Get Live Chat / Inbox Settings
   */
  async getLiveChatSettings(workspaceId: bigint) {
    let settings = await this.prisma.inbox_settings.findFirst({
      where: { workspace_id: workspaceId, module: 'INBOX' },
    });
    if (!settings) {
      settings = await this.prisma.inbox_settings.create({
        data: {
          workspace_id: workspaceId,
          module: 'INBOX',
          key: 'action_on_done',
          value: 'keep',
          save_to_custom_field: 0,
          custom_field: 'Payload',
          data_format: 'full-name',
          append_username: 0,
          ai_prompt: '',
          ai_model: 'gpt-4o-mini',
          save_chat: 0,
          save_chat_as: 'json',
          chat_field: 'Json',
          automatically_pause_automation: true,
        },
      });
    }
    return settings;
  }

  /**
   * Update Live Chat / Inbox Settings
   */
  async updateLiveChatSettings(workspaceId: bigint, data: any) {
    const settings = await this.getLiveChatSettings(workspaceId);
    
    // Map fields
    const updateData: any = {};
    if (data.agentAction !== undefined) updateData.value = data.agentAction;
    if (data.saveAgentDetails !== undefined) updateData.save_to_custom_field = data.saveAgentDetails ? 1 : 0;
    if (data.agentDataFormat !== undefined) updateData.data_format = data.agentDataFormat;
    if (data.customField !== undefined) updateData.custom_field = data.customField;

    if (data.saveConversationJson !== undefined) updateData.save_chat = data.saveConversationJson ? 1 : 0;
    if (data.jsonCustomField !== undefined) updateData.chat_field = data.jsonCustomField;

    if (data.includeSignature !== undefined) updateData.append_username = data.includeSignature ? 1 : 0;

    if (data.correctionModel !== undefined) updateData.ai_model = data.correctionModel;
    if (data.correctionPrompt !== undefined) updateData.ai_prompt = data.correctionPrompt;

    if (data.pauseSmartFlow !== undefined) {
      updateData.automatically_pause_automation = data.pauseSmartFlow === 'automatically';
    }

    return this.prisma.inbox_settings.update({
      where: { id: settings.id },
      data: updateData,
    });
  }

  /**
   * Get formatting/branding settings for White Label.
   * Resolves mid_logo_* and favicon_media_id FK → media_gallery.file_url → signed URL
   * (replyagent Branding model accessor parity — logo/favicon getters).
   */
  async getWorkspaceBranding(workspaceId: bigint) {
    let branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: workspaceId, brandable_type: 'App\\Models\\Workspace' }
    });

    if (!branding) {
      branding = await this.prisma.brandings.create({
        data: {
          brandable_id: workspaceId,
          brandable_type: 'App\\Models\\Workspace',
          color: '#0a7a22',
          link_color: '#5742f5',
          incoming_chat_color: '#705800',
          incoming_chat_text_color: '#ffffff',
          outgoing_chat_color: '#9c9c9c',
          outgoing_chat_text_color: '#ffffff',
        }
      });
    }

    const resolve = async (id: bigint | null | undefined): Promise<string> => {
      if (!id) return '';
      const m = await this.prisma.media_gallery.findUnique({ where: { id } });
      return this.toDisplayUrl(m?.file_url);
    };

    const [logo_light_url, logo_light_small_url, logo_dark_url, logo_dark_small_url, favicon_url] =
      await Promise.all([
        resolve(branding.mid_logo_light),
        resolve(branding.mid_logo_light_small),
        resolve(branding.mid_logo_dark),
        resolve(branding.mid_logo_dark_small),
        resolve(branding.favicon_media_id),
      ]);

    // Replyagent fallback parity: when a workspace logo slot is empty, fall back to the
    // parent agency's branding logo so the agency's brand identity carries through.
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { agency_id: true },
    });
    let agencyBranding: any = null;
    if (workspace?.agency_id) {
      agencyBranding = await this.prisma.brandings.findFirst({
        where: { brandable_id: workspace.agency_id, brandable_type: 'App\\Models\\Agency' },
      });
    }
    let agencyLogoLight = '', agencyLogoLightSmall = '', agencyLogoDark = '', agencyLogoDarkSmall = '', agencyFavicon = '';
    if (agencyBranding) {
      [agencyLogoLight, agencyLogoLightSmall, agencyLogoDark, agencyLogoDarkSmall, agencyFavicon] = await Promise.all([
        resolve(agencyBranding.mid_logo_light),
        resolve(agencyBranding.mid_logo_light_small),
        resolve(agencyBranding.mid_logo_dark),
        resolve(agencyBranding.mid_logo_dark_small),
        resolve(agencyBranding.favicon_media_id),
      ]);
    }

    return {
      ...branding,
      // Effective URLs (workspace's own → fall back to parent agency's).
      logo_light_url: logo_light_url || agencyLogoLight,
      logo_light_small_url: logo_light_small_url || agencyLogoLightSmall,
      logo_dark_url: logo_dark_url || agencyLogoDark,
      logo_dark_small_url: logo_dark_small_url || agencyLogoDarkSmall,
      favicon_url: favicon_url || agencyFavicon,
    };
  }

  /**
   * Accepts a media reference (numeric id, raw S3 key, or signed URL) and resolves it
   * to media_gallery.id. Mirrors agency.service resolver for parity.
   */
  private async resolveBrandingMediaId(
    val: string | number | bigint | null | undefined,
    workspaceId: bigint,
    objectName: string,
  ): Promise<bigint | null> {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number' || typeof val === 'bigint') return BigInt(val);
    if (/^\d+$/.test(String(val))) return BigInt(String(val));

    let key = String(val);
    try {
      if (/^https?:\/\//i.test(key)) {
        const u = new URL(key);
        key = u.pathname.replace(/^\//, '');
      }
    } catch {
      /* leave as-is */
    }

    let media = await this.prisma.media_gallery.findFirst({
      where: { OR: [{ file_url: key }, { file_path: key }] },
    });

    if (!media) {
      media = await this.prisma.media_gallery.create({
        data: {
          workspace_id: workspaceId,
          modelable_id: workspaceId,
          modelable_type: 'App\\Models\\Workspace',
          file_url: key,
          file_path: key,
          object_name: objectName.slice(0, 100),
          media_type: 'IMAGE',
          object_status: 'AVAILABLE',
        },
      });
    }
    return media.id;
  }

  async updateWorkspaceBranding(workspaceId: bigint, data: any) {
    const branding = await this.getWorkspaceBranding(workspaceId);

    const updateData: any = {};
    if (data.mainTheme !== undefined) updateData.color = data.mainTheme;
    if (data.links !== undefined) updateData.link_color = data.links;
    if (data.incomingBubble !== undefined) updateData.incoming_chat_color = data.incomingBubble;
    if (data.incomingText !== undefined) updateData.incoming_chat_text_color = data.incomingText;
    if (data.outgoingBubble !== undefined) updateData.outgoing_chat_color = data.outgoingBubble;
    if (data.outgoingText !== undefined) updateData.outgoing_chat_text_color = data.outgoingText;

    // Logo / Favicon — accept id OR file_url OR signed URL OR null (to clear).
    if (data.logoLight !== undefined)
      updateData.mid_logo_light = await this.resolveBrandingMediaId(data.logoLight, workspaceId, 'Workspace Logo Light');
    if (data.logoLightId !== undefined)
      updateData.mid_logo_light = data.logoLightId === null ? null : BigInt(data.logoLightId);

    if (data.logoLightSmall !== undefined)
      updateData.mid_logo_light_small = await this.resolveBrandingMediaId(data.logoLightSmall, workspaceId, 'Workspace Logo Light Small');
    if (data.logoLightSmallId !== undefined)
      updateData.mid_logo_light_small = data.logoLightSmallId === null ? null : BigInt(data.logoLightSmallId);

    if (data.logoDark !== undefined)
      updateData.mid_logo_dark = await this.resolveBrandingMediaId(data.logoDark, workspaceId, 'Workspace Logo Dark');
    if (data.logoDarkId !== undefined)
      updateData.mid_logo_dark = data.logoDarkId === null ? null : BigInt(data.logoDarkId);

    if (data.logoDarkSmall !== undefined)
      updateData.mid_logo_dark_small = await this.resolveBrandingMediaId(data.logoDarkSmall, workspaceId, 'Workspace Logo Dark Small');
    if (data.logoDarkSmallId !== undefined)
      updateData.mid_logo_dark_small = data.logoDarkSmallId === null ? null : BigInt(data.logoDarkSmallId);

    if (data.favicon !== undefined)
      updateData.favicon_media_id = await this.resolveBrandingMediaId(data.favicon, workspaceId, 'Workspace Favicon');
    if (data.faviconId !== undefined)
      updateData.favicon_media_id = data.faviconId === null ? null : BigInt(data.faviconId);

    await this.prisma.brandings.update({
      where: { id: branding.id },
      data: updateData,
    });

    // Return the freshly-resolved view (signed URLs included).
    return this.getWorkspaceBranding(workspaceId);
  }

  /**
   * Get workspace members with Roles and status
   */
  async getMembers(workspaceId: bigint, filters: any) {
    const users = await this.prisma.users.findMany({
      where: { 
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace'
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        full_name: true,
        email: true,
        status: true,
        locale: true,
        tfa_required: true,
        mobile_access: true,
        receive_sms_notification: true,
        receive_whatsapp_notification: true,
      }
    });

    const userIds = users.map(u => u.id);
    const roleables = await this.prisma.acl_roleables.findMany({
      where: {
        roleable_id: { in: userIds },
        roleable_type: 'App\\Models\\User'
      }
    });

    const roleIds = [...new Set(roleables.map(r => BigInt(r.role_id)))];
    const roles = await this.prisma.acl_roles.findMany({
      where: { id: { in: roleIds } }
    });

    // Batched phone/whatsapp read-back (with country iso2 for the form's country selector)
    const mobiles = userIds.length
      ? await this.prisma.contact_mobiles.findMany({
          where: { modelable_type: 'App\\Models\\User', modelable_id: { in: userIds } },
        })
      : [];
    const countryIds = [...new Set(mobiles.map(m => m.country_id))];
    const countries = countryIds.length
      ? await this.prisma.countries.findMany({ where: { id: { in: countryIds } } })
      : [];
    const iso2Of = (cid: any) => countries.find(c => c.id === cid)?.iso2 || '';

    // Login policies (allowed hours / IP) per user
    const policies = userIds.length
      ? await this.prisma.user_login_policies.findMany({ where: { user_id: { in: userIds } } })
      : [];

    // Access scopes (system/custom fields, tags, agents) per user
    const accesses = userIds.length
      ? await this.prisma.user_accesses.findMany({ where: { user_id: { in: userIds } } })
      : [];
    const accessOf = (uid: bigint, type: string) =>
      accesses.filter(a => a.user_id === uid && a.accessable_type === type).map(a => a.accessable_id.toString());

    return users.map(user => {
      const roleRelation = roleables.find(r => r.roleable_id === user.id);
      const role = roleRelation ? roles.find(r => r.id === BigInt(roleRelation.role_id)) : null;
      const mob = mobiles.find(m => m.modelable_id === user.id && m.slug === 'mobile');
      const wa = mobiles.find(m => m.modelable_id === user.id && m.slug === 'whatsapp');
      const policy = policies.find(p => p.user_id === user.id) || null;
      return {
        ...user,
        role: role ? role.name : 'Agent',
        role_id: role ? role.id.toString() : null,
        phone: mob?.mobile_number || '',
        phone_country: mob ? iso2Of(mob.country_id) : '',
        whatsapp: wa?.mobile_number || '',
        whatsapp_country: wa ? iso2Of(wa.country_id) : '',
        login_policy: policy,
        systemFields: accessOf(user.id, 'App\\Models\\SystemField'),
        customFields: accessOf(user.id, 'App\\Models\\CustomField'),
        tags: accessOf(user.id, 'App\\Models\\Tag'),
        agents: accessOf(user.id, 'App\\Models\\User'),
      };
    });
  }

  /**
   * Add member to workspace (Invite logic)
   */
  async addMember(workspaceId: bigint, creatorId: bigint, data: any) {
    const { email, first_name, last_name, role_id, locale, tfa_required, mobile_access } = data;

    // Check if user already exists
    let user = await this.prisma.users.findFirst({
      where: { email, modelable_id: workspaceId, modelable_type: 'App\\Models\\Workspace' }
    });

    if (user) {
      throw new BadRequestException('User already a member of this workspace');
    }

    const full_name = last_name ? `${first_name} ${last_name}` : first_name;

    user = await this.prisma.users.create({
      data: {
        email,
        first_name: first_name || email.split('@')[0],
        last_name: last_name || '',
        full_name: full_name || email.split('@')[0],
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace',
        status: 'ACTIVE',
        password: '', // Handled via invite link typically
        creator_id: creatorId,
        active_workspace_id: workspaceId,
        locale: locale || 'en-US',
        tfa_required: !!tfa_required,
        mobile_access: mobile_access === false || mobile_access === 0 ? 0 : 1,
        receive_sms_notification: !!data.receive_sms_notification,
        receive_whatsapp_notification: !!data.receive_whatsapp_notification,
      },
    });

    if (role_id) {
      await this.prisma.acl_roleables.create({
        data: {
          role_id: Number(role_id),
          roleable_id: user.id,
          roleable_type: 'App\\Models\\User',
        },
      });
    }

    // Persist phone / whatsapp into contact_mobiles (replyagent parity)
    try {
      await this.upsertWorkspaceUserMobile(user.id, workspaceId, 'mobile', data.phone_country, data.phone);
      await this.upsertWorkspaceUserMobile(user.id, workspaceId, 'whatsapp', data.whatsapp_country, data.whatsapp);
    } catch (err: any) {
      this.logger.warn(`Failed to save member contact numbers: ${err?.message ?? err}`);
    }

    try {
      if (data.loginPolicy) await this.saveLoginPolicy(user.id, data.loginPolicy);
    } catch (err: any) {
      this.logger.warn(`Failed to save login policy: ${err?.message ?? err}`);
    }

    try {
      await this.syncUserAccesses(user.id, data);
    } catch (err: any) {
      this.logger.warn(`Failed to save access scopes: ${err?.message ?? err}`);
    }

    return user;
  }

  /**
   * Delete/Remove member
   */
  async deleteMember(workspaceId: bigint, memberId: bigint) {
    // Delete roles first
    await this.prisma.acl_roleables.deleteMany({
      where: {
        roleable_id: memberId,
        roleable_type: 'App\\Models\\User'
      }
    });

    return this.prisma.users.deleteMany({
      where: { 
        id: memberId,
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace'
      },
    });
  }

  /**
   * Update member
   */
  async updateMember(workspaceId: bigint, memberId: bigint, data: any) {
    const { email, first_name, last_name, role_id, locale, tfa_required, mobile_access } = data;

    // Convert to Prisma update data
    const updateData: any = {};
    if (email !== undefined) updateData.email = email;
    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (first_name !== undefined || last_name !== undefined) {
      updateData.full_name = `${first_name || ''} ${last_name || ''}`.trim();
    }
    if (locale !== undefined) updateData.locale = locale;
    if (tfa_required !== undefined) updateData.tfa_required = !!tfa_required;
    if (mobile_access !== undefined) updateData.mobile_access = mobile_access === false || mobile_access === 0 ? 0 : 1;
    if (data.receive_sms_notification !== undefined) updateData.receive_sms_notification = !!data.receive_sms_notification;
    if (data.receive_whatsapp_notification !== undefined) updateData.receive_whatsapp_notification = !!data.receive_whatsapp_notification;

    const updated = await this.prisma.users.updateMany({
      where: {
        id: memberId,
        modelable_id: workspaceId,
        modelable_type: 'App\\Models\\Workspace'
      },
      data: updateData,
    });

    if (role_id !== undefined) {
      // Delete existing roles and create new one (simpler than update)
      await this.prisma.acl_roleables.deleteMany({
        where: { roleable_id: memberId, roleable_type: 'App\\Models\\User' }
      });
      await this.prisma.acl_roleables.create({
        data: {
          role_id: Number(role_id),
          roleable_id: memberId,
          roleable_type: 'App\\Models\\User',
        }
      });
    }

    // Persist phone / whatsapp into contact_mobiles (replyagent parity)
    try {
      await this.upsertWorkspaceUserMobile(memberId, workspaceId, 'mobile', data.phone_country, data.phone);
      await this.upsertWorkspaceUserMobile(memberId, workspaceId, 'whatsapp', data.whatsapp_country, data.whatsapp);
    } catch (err: any) {
      this.logger.warn(`Failed to update member contact numbers: ${err?.message ?? err}`);
    }

    try {
      if (data.loginPolicy) await this.saveLoginPolicy(memberId, data.loginPolicy);
    } catch (err: any) {
      this.logger.warn(`Failed to update login policy: ${err?.message ?? err}`);
    }

    try {
      await this.syncUserAccesses(memberId, data);
    } catch (err: any) {
      this.logger.warn(`Failed to update access scopes: ${err?.message ?? err}`);
    }

    return updated;
  }

  // Strip a phone number down to digits (mirrors replyagent ContactHelper::removeNumberFormating)
  private cleanNumber(n: string): string {
    return String(n ?? '').trim().replace(/^[0+]+/, '').replace(/[^0-9]/g, '');
  }

  /**
   * Persist a workspace agent's mobile / whatsapp into contact_mobiles, polymorphic
   * on the User, owned by the Workspace — mirrors replyagent ContactHelper::updateContactFields.
   * One row per (user, slug). No value → nothing written.
   */
  private async upsertWorkspaceUserMobile(
    userId: bigint,
    workspaceId: bigint,
    slug: 'mobile' | 'whatsapp',
    iso2: string | undefined,
    rawValue: string | undefined,
  ) {
    const digits = this.cleanNumber(rawValue ?? '');
    if (!digits) return;

    const country = iso2
      ? await this.prisma.countries.findFirst({ where: { iso2: iso2.toUpperCase() } })
      : null;
    if (!country) return; // country_id is required on contact_mobiles

    const phoneCode = String(country.phone_code ?? '').replace(/[^0-9]/g, '');
    const national = `${phoneCode}${digits}`;
    const full = `+${national}`;

    const fields = {
      country_id: country.id,
      country_code: country.phone_code ?? null,
      mobile_number: digits,
      national_mobile_number: national,
      full_mobile_number: full,
      type: slug,
      is_primary: 1,
      updated_at: new Date(),
    };

    const existing = await this.prisma.contact_mobiles.findFirst({
      where: { modelable_type: 'App\\Models\\User', modelable_id: userId, slug },
    });

    if (existing) {
      await this.prisma.contact_mobiles.update({ where: { id: existing.id }, data: fields });
    } else {
      await this.prisma.contact_mobiles.create({
        data: {
          ...fields,
          slug,
          modelable_type: 'App\\Models\\User',
          modelable_id: userId,
          ownership_type: 'App\\Models\\Workspace',
          ownership_id: workspaceId,
        },
      });
    }
  }

  /**
   * Upsert a user's login policy (allowed login hours per weekday + IP restriction).
   * One row per user — mirrors replyagent user_login_policies / saveAccessParams.
   */
  private async saveLoginPolicy(userId: bigint, policy: any) {
    if (!policy || typeof policy !== 'object') return;
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const data: any = {
      limit_by_ip: !!policy.limit_by_ip,
      ip: policy.ip || null,
      updated_at: new Date(),
    };
    for (const d of days) {
      data[`${d}_login`] = policy[`${d}_login`] || null;
      data[`${d}_logout`] = policy[`${d}_logout`] || null;
    }
    const existing = await this.prisma.user_login_policies.findFirst({ where: { user_id: userId } });
    if (existing) {
      await this.prisma.user_login_policies.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.user_login_policies.create({ data: { ...data, user_id: userId } });
    }
  }

  // Morph types for the agent access scopes (replyagent user_accesses)
  private static ACCESS_TYPES: { key: string; type: string }[] = [
    { key: 'systemFields', type: 'App\\Models\\SystemField' },
    { key: 'customFields', type: 'App\\Models\\CustomField' },
    { key: 'tags', type: 'App\\Models\\Tag' },
    { key: 'agents', type: 'App\\Models\\User' },
  ];

  /**
   * Sync an agent's access scopes (which system fields / custom fields / tags / agents
   * they can see) into the polymorphic user_accesses table — mirrors replyagent saveAccessParams.
   * Only the kinds actually present in `data` are touched, so other scopes (e.g. channels) survive.
   */
  private async syncUserAccesses(userId: bigint, data: any) {
    const provided = WorkspacesService.ACCESS_TYPES.filter((m) => Array.isArray(data[m.key]));
    if (provided.length === 0) return;
    const types = provided.map((m) => m.type);
    await this.prisma.user_accesses.deleteMany({
      where: { user_id: userId, accessable_type: { in: types } },
    });
    const rows: any[] = [];
    for (const m of provided) {
      for (const x of data[m.key] as any[]) {
        let id: bigint;
        try { id = BigInt(x); } catch { continue; }
        if (id > 0n) rows.push({ user_id: userId, accessable_type: m.type, accessable_id: id });
      }
    }
    if (rows.length) await this.prisma.user_accesses.createMany({ data: rows });
  }

  /**
   * Roles Management
   */
  async getRoles(workspaceId: bigint) {
    const roles = await this.prisma.acl_roles.findMany({
      where: {
        ownerable_id: workspaceId,
        ownerable_type: 'App\\Models\\Workspace'
      }
    });

    return roles.map(r => ({
      ...r,
      isArchived: r.status === 'ARCHIVE',
      permissions: {}, 
    }));
  }

  async createRole(workspaceId: bigint, data: any) {
    // Stable, unique machine key — mirrors replyagent exactly:
    //   "ar_<workspaceId>_<slugified-name>_<unix-timestamp>"
    // The timestamp guarantees uniqueness even for duplicate names.
    const base = String(data.name ?? '')
      .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const slug = `ar_${workspaceId}_${base}_${Math.floor(Date.now() / 1000)}`;
    return this.prisma.acl_roles.create({
      data: {
        ownerable_id: workspaceId,
        ownerable_type: 'App\\Models\\Workspace',
        name: data.name,
        slug: slug,
        description: data.description || '',
        icon: data.icon || 'fa-user-tie',
        status: 'ACTIVE',
        system: false,
        admin: false,
      }
    });
  }

  async updateRole(workspaceId: bigint, roleId: bigint, data: any) {
    const updateData: any = {};
    if (data.name) {
      // Name can change; the slug stays fixed (permanent unique key,
      // replyagent parity — assignments link by role_id, not slug).
      updateData.name = data.name;
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.icon) updateData.icon = data.icon;
    if (data.isArchived !== undefined) updateData.status = data.isArchived ? 'ARCHIVE' : 'ACTIVE';

    return this.prisma.acl_roles.update({
      where: { id: roleId },
      data: updateData,
    });
  }

  async deleteRole(workspaceId: bigint, roleId: bigint) {
    return this.prisma.acl_roles.deleteMany({
      where: {
        id: roleId,
        ownerable_id: workspaceId,
        ownerable_type: 'App\\Models\\Workspace'
      }
    });
  }

  /**
   * Business Hours Persistence
   * Uses user_states table: type = 'business_hours', data = JSON string
   */
  async getBusinessHours(workspaceId: bigint, userId: bigint) {
    const state = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'business_hours' },
    });
    return state ? JSON.parse(state.data) : null;
  }

  async updateBusinessHours(workspaceId: bigint, userId: bigint, data: any) {
    const existing = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'business_hours' },
    });

    if (existing) {
      return this.prisma.user_states.update({
        where: { id: existing.id },
        data: { data: JSON.stringify(data) },
      });
    }

    return this.prisma.user_states.create({
      data: {
        user_id: userId,
        type: 'business_hours',
        data: JSON.stringify(data),
      },
    });
  }

  /**
   * AI Assistants Settings
   * Persists content_prompts toggle and terms agreement via user_states
   */
  async getAIAssistantSettings(workspaceId: bigint, userId: bigint) {
    const state = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'ai_assistant_settings' },
    });
    if (state) return JSON.parse(state.data);
    return { agreeToTerms: false, contentPrompts: false };
  }

  async updateAIAssistantSettings(workspaceId: bigint, userId: bigint, data: any) {
    const existing = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'ai_assistant_settings' },
    });

    if (existing) {
      return this.prisma.user_states.update({
        where: { id: existing.id },
        data: { data: JSON.stringify(data) },
      });
    }

    return this.prisma.user_states.create({
      data: {
        user_id: userId,
        type: 'ai_assistant_settings',
        data: JSON.stringify(data),
      },
    });
  }

  /**
   * Password Policy Persistence
   * Uses user_states table with type 'password_policy'
   */
  async getPasswordPolicy(workspaceId: bigint, userId: bigint) {
    const state = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'password_policy' },
    });
    if (state) return JSON.parse(state.data);
    return {
      policyEnabled: false,
      policyName: '',
      expirationDays: 90,
      reuseCount: 5,
      lockoutThreshold: 5,
    };
  }

  async updatePasswordPolicy(workspaceId: bigint, userId: bigint, data: any) {
    const existing = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'password_policy' },
    });

    if (existing) {
      return this.prisma.user_states.update({
        where: { id: existing.id },
        data: { data: JSON.stringify(data) },
      });
    }

    return this.prisma.user_states.create({
      data: {
        user_id: userId,
        type: 'password_policy',
        data: JSON.stringify(data),
      },
    });
  }

  /**
   * Developer Settings Persistence
   * Uses user_states table with type 'developer_settings'
   */
  async getDeveloperSettings(workspaceId: bigint, userId: bigint) {
    const state = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'developer_settings' },
    });
    if (state) return JSON.parse(state.data);
    
    // Default settings if none exist
    return {
      apiKey: this.generateRandomKey(40),
      webhooks: [],
    };
  }

  async updateDeveloperSettings(workspaceId: bigint, userId: bigint, data: any) {
    const existing = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'developer_settings' },
    });

    let finalData = { ...data };
    if (data.regenerateKey) {
      finalData.apiKey = this.generateRandomKey(40);
      delete finalData.regenerateKey;
    }

    if (existing) {
      const currentData = JSON.parse(existing.data);
      const mergedData = { ...currentData, ...finalData };
      return this.prisma.user_states.update({
        where: { id: existing.id },
        data: { data: JSON.stringify(mergedData) },
      });
    }

    return this.prisma.user_states.create({
      data: {
        user_id: userId,
        type: 'developer_settings',
        data: JSON.stringify(finalData),
      },
    });
  }

  private generateRandomKey(length: number): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }
}
