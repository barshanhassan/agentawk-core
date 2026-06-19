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
      // Agency-owner impersonation path — replyagent parity.
      // The workspace's "Allow Support" toggle (allow_support) lets the workspace
      // refuse agency access. When OFF the agency owner must not see / switch into it.
      // Workspace members are unaffected (they hit the else branch via agency_user_id).
      wsList = await this.prisma.workspaces.findMany({
        where: {
          agency_id: agencyId,
          deleted_at: null,
          status: 'ACTIVE',
          allow_support: true,
        },
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
    // Touch updated_at so logs/sorting reflect the change (replyagent/Laravel
    // auto-touches; EZCONN's introspected schema has no DB-side default).
    updateData.updated_at = new Date();

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
        is_owner: true,
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

    // Resolve each member's permission slugs (mirrors AuthService.loadUserPermissions,
    // but batched for the whole member list): owner → wildcards; otherwise the
    // member's role permissions + any direct entity permissions. The frontend uses
    // this to gate per-agent UI (e.g. only agents with `receive_tasks` appear in the
    // task-assignee dropdown — replyagent's getUsers()).
    const rolePerms = roleIds.length
      ? await this.prisma.acl_role_permissions.findMany({ where: { role_id: { in: roleIds.map(r => Number(r)) } } })
      : [];
    const entityPerms = userIds.length
      ? await this.prisma.acl_entity_permissions.findMany({ where: { entity_id: { in: userIds }, entity_type: 'App\\Models\\User' } })
      : [];
    const allPermIds = [...new Set([...rolePerms.map(rp => rp.permission_id), ...entityPerms.map(ep => ep.permission_id)])];
    const permRows = allPermIds.length
      ? await this.prisma.acl_permissions.findMany({ where: { id: { in: allPermIds } }, select: { id: true, slug: true } })
      : [];
    const slugByPermId = new Map(permRows.map(p => [p.id.toString(), p.slug]));
    const slugsByRole = new Map<string, string[]>();
    for (const rp of rolePerms) {
      const slug = slugByPermId.get(rp.permission_id.toString());
      if (!slug) continue;
      const rid = rp.role_id.toString();
      const arr = slugsByRole.get(rid) ?? [];
      arr.push(slug);
      slugsByRole.set(rid, arr);
    }
    const entitySlugsByUser = new Map<string, string[]>();
    for (const ep of entityPerms) {
      const slug = slugByPermId.get(ep.permission_id.toString());
      if (!slug) continue;
      const uid = ep.entity_id.toString();
      const arr = entitySlugsByUser.get(uid) ?? [];
      arr.push(slug);
      entitySlugsByUser.set(uid, arr);
    }

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

    // Access scopes (system/custom fields, tags, agents, channels) per user
    const accesses = userIds.length
      ? await this.prisma.user_accesses.findMany({ where: { user_id: { in: userIds } } })
      : [];
    const accessOf = (uid: bigint, type: string) =>
      accesses.filter(a => a.user_id === uid && a.accessable_type === type).map(a => a.accessable_id.toString());

    // Per-agent limits (open conversations / opportunities / tasks / incoming calls)
    const limitsRows = userIds.length
      ? await this.prisma.user_limits.findMany({ where: { user_id: { in: userIds } } })
      : [];

    return users.map(user => {
      const roleRelation = roleables.find(r => r.roleable_id === user.id);
      const role = roleRelation ? roles.find(r => r.id === BigInt(roleRelation.role_id)) : null;
      // Resolved permission slugs for this member (owner → wildcards).
      const permissions = (user as any).is_owner
        ? ['agency.*', 'workspace.*']
        : [...new Set([
            ...(roleRelation ? (slugsByRole.get(roleRelation.role_id.toString()) ?? []) : []),
            ...(entitySlugsByUser.get(user.id.toString()) ?? []),
          ])];
      const mob = mobiles.find(m => m.modelable_id === user.id && m.slug === 'mobile');
      const wa = mobiles.find(m => m.modelable_id === user.id && m.slug === 'whatsapp');
      const policy = policies.find(p => p.user_id === user.id) || null;
      const lim = limitsRows.find(l => l.user_id === user.id) || null;
      // Rebuild the channels object (per-type accessable id lists) — replyagent accessableChannels()
      const channels: Record<string, string[]> = {};
      for (const m of WorkspacesService.CHANNEL_ACCESS_TYPES) channels[m.key] = accessOf(user.id, m.type);
      return {
        ...user,
        role: role ? role.name : 'Agent',
        role_id: role ? role.id.toString() : null,
        phone: mob?.mobile_number || '',
        phone_country: mob ? iso2Of(mob.country_id) : '',
        whatsapp: wa?.mobile_number || '',
        whatsapp_country: wa ? iso2Of(wa.country_id) : '',
        login_policy: policy,
        limits: {
          enable_conversation: lim?.enable_conversation ?? 0,
          conversation_limit: lim?.conversation_limit ?? 0,
          enable_opportunities: lim?.enable_opportunities ?? 0,
          opportunities_limit: lim?.opportunities_limit ?? 0,
          enable_tasks: lim?.enable_tasks ?? 0,
          tasks_limit: lim?.tasks_limit ?? 0,
          enable_call_limit: lim?.enable_call_limit ?? 0,
          calls_limit: lim?.calls_limit ?? 0,
        },
        systemFields: accessOf(user.id, 'App\\Models\\SystemField'),
        customFields: accessOf(user.id, 'App\\Models\\Fields\\CustomField'),
        tags: accessOf(user.id, 'App\\Models\\Tag\\Tag'),
        agents: accessOf(user.id, 'App\\Models\\User'),
        channels,
        permissions,
      };
    });
  }

  /**
   * Aggregate every conversation channel configured for a workspace, grouped by type —
   * mirrors replyagent's GET /all-channels (Workspace::allChannels) used by the agent
   * "Chat Channels" access tab. Display shape per type matches the replyagent frontend.
   */
  async getAllChannels(workspaceId: bigint) {
    const [telegram, twilioAccounts, messenger, instagram, zapi, webchat, waAccounts] = await Promise.all([
      this.prisma.telegram_bots.findMany({ where: { workspace_id: workspaceId, deleted_at: null } }),
      this.prisma.twilio_accounts.findMany({ where: { workspace_id: workspaceId, deleted_at: null } }),
      this.prisma.fb_pages.findMany({ where: { workspace_id: workspaceId, deleted_at: null } }),
      this.prisma.insta_pages.findMany({ where: { workspace_id: workspaceId, deleted_at: null } }),
      this.prisma.zapi_instances.findMany({ where: { workspace_id: workspaceId, deleted_at: null } }),
      this.prisma.wc_instances.findMany({ where: { workspace_id: workspaceId, deleted_at: null } }),
      this.prisma.wa_accounts.findMany({ where: { workspace_id: workspaceId, deleted_at: null }, select: { id: true } }),
    ]);

    // WhatsApp channels are the phone numbers under this workspace's WABA accounts.
    const waAccountIds = waAccounts.map(a => a.id);
    const waNumbers = waAccountIds.length
      ? await this.prisma.wa_phone_numbers.findMany({ where: { wa_account_id: { in: waAccountIds } } })
      : [];

    // Twilio: replyagent flattens accounts → numbers (each number is a selectable channel).
    const twilioAccountIds = twilioAccounts.map(a => a.id);
    const twilioNumbers = twilioAccountIds.length
      ? await this.prisma.twilio_numbers.findMany({ where: { twilio_account_id: { in: twilioAccountIds }, deleted_at: null } })
      : [];
    const twAccName = (id: bigint) => twilioAccounts.find(a => a.id === id)?.name || 'Twilio';

    return {
      channels: {
        whatsapp: waNumbers.map(n => ({ id: n.id.toString(), verified_name: n.verified_name, display_phone_number: n.display_phone_number })),
        zapi: zapi.map(z => ({ id: z.id.toString(), name: z.name, phone_number: z.phone_number ?? null })),
        telegram: telegram.map(t => ({ id: t.id.toString(), name: t.name })),
        twilio: twilioNumbers.map(n => ({ id: n.id.toString(), account_name: twAccName(n.twilio_account_id), twilio_phone_number: n.twilio_phone_number })),
        messenger: messenger.map(p => ({ id: p.id.toString(), name: p.name })),
        instagram: instagram.map(p => ({ id: p.id.toString(), name: p.name })),
        webchat: webchat.map(w => ({ id: w.id.toString(), name: w.name })),
      },
    };
  }

  /**
   * Add member to workspace (Invite logic)
   */
  async addMember(workspaceId: bigint, creatorId: bigint, data: any) {
    const { email, first_name, last_name, role_id, locale, tfa_required, mobile_access } = data;

    // Enforce workspace agents_limit — replyagent parity.
    // gateway/app/Http/Controllers/Api/WorkspacesController.php:337-341:
    //   if ($total_members >= $request->site->agents_limit) {
    //     return $this->respondError("Reached the limit", 'LIMIT_REACHED', 400);
    //   }
    // Replyagent's Workspace::members() (Workspace.php:128-131) is a plain
    // morphMany without scopes, and User does NOT use SoftDeletes. The EZCONN
    // deleteMember below also performs a hard delete (prisma.users.deleteMany).
    // So a simple count of all rows for this workspace = active member count.
    // (users_status enum has no DELETED variant — earlier filter was invalid.)
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { agents_limit: true },
    });
    const limit = Number(workspace?.agents_limit ?? 0);
    if (limit > 0) {
      const totalMembers = await this.prisma.users.count({
        where: {
          modelable_id: workspaceId,
          modelable_type: 'App\\Models\\Workspace',
        },
      });
      if (totalMembers >= limit) {
        throw new BadRequestException('Reached the limit');
      }
    }

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
      if (data.limits) await this.saveLimits(user.id, data.limits);
    } catch (err: any) {
      this.logger.warn(`Failed to save agent limits: ${err?.message ?? err}`);
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
      if (data.limits) await this.saveLimits(memberId, data.limits);
    } catch (err: any) {
      this.logger.warn(`Failed to update agent limits: ${err?.message ?? err}`);
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

  // Morph types for the agent access scopes (replyagent user_accesses). These match the
  // exact accessable_type strings stored in the production DB (verified against the dump):
  // CustomField → App\Models\Fields\CustomField, Tag → App\Models\Tag\Tag (namespaced).
  private static ACCESS_TYPES: { key: string; type: string }[] = [
    { key: 'systemFields', type: 'App\\Models\\SystemField' },
    { key: 'customFields', type: 'App\\Models\\Fields\\CustomField' },
    { key: 'tags', type: 'App\\Models\\Tag\\Tag' },
    { key: 'agents', type: 'App\\Models\\User' },
  ];

  // Morph types for the per-channel access scopes (replyagent UserAccessTrait::saveAccessParams).
  // The frontend sends a `channels` object keyed by these same keys.
  private static CHANNEL_ACCESS_TYPES: { key: string; type: string }[] = [
    { key: 'whatsapp', type: 'App\\Models\\Whatsapp\\WhatsappNumber' },
    { key: 'zapi', type: 'App\\Models\\Zapi\\ZapiInstance' },
    { key: 'twilio', type: 'App\\Models\\TwilioNumber' },
    { key: 'telegram', type: 'App\\Models\\TelegramBot' },
    { key: 'messenger', type: 'App\\Models\\Facebook\\FacebookPage' },
    { key: 'instagram', type: 'App\\Models\\Instagram\\InstagramPage' },
    { key: 'webchat', type: 'App\\Models\\Webchat\\WcInstance' },
  ];

  private static toBigIntIds(arr: any[]): bigint[] {
    const out: bigint[] = [];
    for (const x of arr || []) {
      let id: bigint;
      try { id = BigInt(x); } catch { continue; }
      if (id > 0n) out.push(id);
    }
    return out;
  }

  /**
   * Sync an agent's access scopes (system/custom fields, tags, agents, and per-channel
   * access) into the polymorphic user_accesses table — mirrors replyagent saveAccessParams.
   * Only the kinds actually present in `data` are touched, so untouched scopes survive.
   * The agent is always granted access to their own conversations (replyagent includes self).
   */
  private async syncUserAccesses(userId: bigint, data: any) {
    const buckets: { type: string; ids: bigint[] }[] = [];

    for (const m of WorkspacesService.ACCESS_TYPES) {
      if (!Array.isArray(data[m.key])) continue;
      let ids = WorkspacesService.toBigIntIds(data[m.key]);
      // accessableAgents always includes the agent themselves (replyagent parity).
      if (m.key === 'agents') ids = [...ids, userId];
      buckets.push({ type: m.type, ids });
    }

    const channels = data.channels;
    if (channels && typeof channels === 'object' && !Array.isArray(channels)) {
      for (const m of WorkspacesService.CHANNEL_ACCESS_TYPES) {
        if (!Array.isArray(channels[m.key])) continue;
        buckets.push({ type: m.type, ids: WorkspacesService.toBigIntIds(channels[m.key]) });
      }
    }

    if (buckets.length === 0) return;

    const types = buckets.map((b) => b.type);
    await this.prisma.user_accesses.deleteMany({
      where: { user_id: userId, accessable_type: { in: types } },
    });

    // Dedupe by (type,id) so the self-include or any repeats can't violate uniqueness.
    const seen = new Set<string>();
    const rows: any[] = [];
    for (const b of buckets) {
      for (const id of b.ids) {
        const key = `${b.type}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ user_id: userId, accessable_type: b.type, accessable_id: id });
      }
    }
    if (rows.length) await this.prisma.user_accesses.createMany({ data: rows });
  }

  /**
   * Upsert an agent's limits (max open conversations / opportunities / tasks / incoming
   * calls per day, each independently toggleable) — mirrors replyagent user_limits.
   */
  private async saveLimits(userId: bigint, limits: any) {
    if (!limits || typeof limits !== 'object') return;
    const num = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const data: any = {
      enable_conversation: limits.enable_conversation ? 1 : 0,
      conversation_limit: num(limits.conversation_limit),
      enable_opportunities: limits.enable_opportunities ? 1 : 0,
      opportunities_limit: num(limits.opportunities_limit),
      enable_tasks: limits.enable_tasks ? 1 : 0,
      tasks_limit: num(limits.tasks_limit),
      enable_call_limit: limits.enable_call_limit ? 1 : 0,
      calls_limit: num(limits.calls_limit),
      updated_at: new Date(),
    };
    const existing = await this.prisma.user_limits.findFirst({ where: { user_id: userId } });
    if (existing) {
      await this.prisma.user_limits.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.user_limits.create({ data: { ...data, user_id: userId, created_at: new Date() } });
    }
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

  // Note: the previous `getDeveloperSettings` / `updateDeveloperSettings`
  // methods (stored a fake API key + webhooks JSON in user_states) were
  // removed. The Developer Settings UI now reads from the real
  // `users.api_token` column and the dedicated `webhooks` table. Existing
  // user_states rows of type 'developer_settings' are no longer queried —
  // they remain in the table as inert legacy data and can be cleaned up
  // by a one-shot DB script if desired.
}
