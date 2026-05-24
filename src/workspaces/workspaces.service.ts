// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(private readonly prisma: PrismaService) {}

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
   * Get formatting/branding settings for White Label 
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

    return branding;
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

    return users.map(user => {
      const roleRelation = roleables.find(r => r.roleable_id === user.id);
      const role = roleRelation ? roles.find(r => r.id === BigInt(roleRelation.role_id)) : null;
      return {
        ...user,
        role: role ? role.name : 'Agent',
        role_id: role ? role.id.toString() : null
      };
    });
  }

  /**
   * Add member to workspace (Invite logic)
   */
  async addMember(workspaceId: bigint, creatorId: bigint, data: any) {
    const { email, first_name, last_name, role_id } = data;
    
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
    const { email, first_name, last_name, role_id } = data;
    
    // Convert to Prisma update data
    const updateData: any = {};
    if (email !== undefined) updateData.email = email;
    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (first_name !== undefined || last_name !== undefined) {
      updateData.full_name = `${first_name || ''} ${last_name || ''}`.trim();
    }

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

    return updated;
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
