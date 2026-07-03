// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Replyagent parity: Str::random(50) for slugs. Used for sharing (import-by-slug)
  // and for connection routing (step/activity slugs travel between version clones).
  private generateSlug(bytes = 20): string {
    return crypto.randomBytes(bytes).toString('hex'); // 40 chars hex, fits VARCHAR(50)
  }

  /**
   * Get list of automations + folders — replyagent parity for filters.
   *   - folder_id: ALL | <id> | null (root)
   *   - search:    LIKE %name%
   *   - users:     whereIn(creator_id) — for filtering by creator
   *   - status:    by default exclude draft+unpublished+archive unless include_unpublished
   *   - excludes soft-deleted (deleted_at IS NULL)
   *   - excludes moduleable (sub-automations attached to bundles, etc.)
   * Also enriches each row with `created_by` info so the page can render creator avatars
   * without a separate users fetch.
   */
  async getAutomations(workspaceId: bigint, filters: any) {
    const where: any = {
      workspace_id: workspaceId,
      deleted_at: null,
      moduleable_id: null,
    };

    if (filters.folder_id && filters.folder_id !== 'ALL') {
      where.folder_id = BigInt(filters.folder_id);
    }

    if (filters.search) {
      where.name = { contains: String(filters.search) };
    }

    if (filters.users) {
      const userIds = Array.isArray(filters.users)
        ? filters.users
        : String(filters.users).split(',').filter(Boolean);
      if (userIds.length) {
        where.creator_id = { in: userIds.map((u: any) => BigInt(u)) };
      }
    }

    if (!filters.include_unpublished) {
      where.status = { in: ['draft', 'active', 'error', 'archive'] };
    }

    const automations = await this.prisma.automations.findMany({
      where,
      orderBy: { id: 'desc' },
    });

    // Resolve creator details (only the IDs we actually need)
    const creatorIds = [...new Set(automations.map((a: any) => a.creator_id).filter(Boolean))];
    const creators = creatorIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: creatorIds as any } },
          select: { id: true, first_name: true, last_name: true, email: true },
        })
      : [];
    const creatorMap = new Map(creators.map((c: any) => [c.id.toString(), c]));

    const enriched = automations.map((a: any) => ({
      ...a,
      created_by: creatorMap.get(a.creator_id?.toString()) || null,
      last_updated: a.updated_at,
    }));

    const folders = await this.prisma.automation_folders.findMany({
      where: { workspace_id: workspaceId },
    });

    return { success: true, automations: enriched, folders };
  }

  /**
   * Get full automation data including the requested version's steps + activities.
   * Replyagent: ?mode=published falls back to draft if no published version exists.
   */
  async getAutomation(workspaceId: bigint, automationId: bigint, mode: string = 'draft') {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    // Mode resolution (replyagent parity)
    let versionId: bigint | null = null;
    let resolvedMode = 'draft';
    if (mode === 'published' && automation.published_version_id) {
      versionId = automation.published_version_id as any;
      resolvedMode = 'published';
    } else {
      versionId = automation.draft_version_id as any;
    }

    // Schema has no Prisma `relation` between automation_versions and automation_steps,
    // and no relation between automation_steps and automation_step_activities. We can't
    // `include` them — fetch separately by FK and stitch.
    let version: any = null;
    if (versionId) {
      const versionRow = await this.prisma.automation_versions.findUnique({
        where: { id: versionId },
      });
      if (versionRow) {
        const steps = await this.prisma.automation_steps.findMany({
          where: { automation_version_id: versionRow.id, deleted_at: null },
          orderBy: { id: 'asc' },
        });
        const stepIds = steps.map((s: any) => s.id);
        const activities = stepIds.length
          ? await this.prisma.automation_step_activities.findMany({
              where: { step_id: { in: stepIds }, deleted_at: null },
              orderBy: { order: 'asc' },
            })
          : [];
        const activitiesByStep = new Map<string, any[]>();
        for (const a of activities) {
          const key = a.step_id.toString();
          if (!activitiesByStep.has(key)) activitiesByStep.set(key, []);
          activitiesByStep.get(key)!.push(a);
        }
        version = {
          ...versionRow,
          automation_steps: steps.map((s: any) => ({
            ...s,
            automation_step_activities: activitiesByStep.get(s.id.toString()) || [],
          })),
        };
      }
    }

    // Load flow connections + translate step ids back to FE node ids so the
    // frontend's edge hydrator can wire them straight to the rendered
    // nodes. Without this the sync-graph writes lands `connector_id` /
    // `next_step_id` as numeric step ids that don't match the FE's
    // `node_XXX` node ids, and every reload silently drops all edges.
    let flows: any[] = [];
    if (versionId && version) {
      const rawFlows = await this.prisma.automation_flow.findMany({
        where: { automation_version_id: versionId, deleted_at: null },
      });
      const stepIdToNodeId = new Map<string, string>();
      for (const s of (version.automation_steps ?? []) as any[]) {
        stepIdToNodeId.set(String(s.id), String(s.comment ?? `step_${s.id}`));
      }
      flows = rawFlows.map((f: any) => {
        // Slug may be `sh:<handle>:<random>` when the edge was
        // created from a specific source handle (e.g. Randomizer A/B).
        // See the write-side comment in syncGraph.
        let sourceHandle: string | null = null;
        if (typeof f.slug === 'string' && f.slug.startsWith('sh:')) {
          const rest = f.slug.substring(3);
          const idx = rest.indexOf(':');
          if (idx > 0) {
            sourceHandle = rest.substring(0, idx);
          }
        }
        return {
          id: String(f.id),
          source_node_id: stepIdToNodeId.get(String(f.connector_id)) ?? null,
          target_node_id: stepIdToNodeId.get(String(f.next_step_id)) ?? null,
          source_handle: sourceHandle,
          connector_id: f.connector_id?.toString?.() ?? f.connector_id,
          next_step_id: f.next_step_id?.toString?.() ?? f.next_step_id,
        };
      });
    }

    return {
      success: true,
      automation: { ...automation, version },
      steps: (version?.automation_steps ?? []),
      flows,
      mode: resolvedMode,
    };
  }

  /**
   * Create a new automation — replyagent parity (AutomationsController::createAutomation).
   * Sets creator_id + updater_id, generates slug, and seeds the draft version with a
   * non-deletable "Starting step" (trigger) + a default activity, so the builder canvas
   * isn't blank on open.
   */
  async createAutomation(workspaceId: bigint, userId: bigint, data: any) {
    const { name, folder_id, trigger_step_name } = data;
    if (!name) throw new BadRequestException('Name is required');

    // 1. Create automation row with creator/updater + slug.
    // Prisma schema lacks @updatedAt/@default(now()) on these timestamps — set them
    // explicitly so frontend's Last Updated column doesn't show "-" right after create.
    const now = new Date();
    const automation = await this.prisma.automations.create({
      data: {
        workspace_id: workspaceId,
        name,
        folder_id: folder_id ? BigInt(folder_id) : null,
        status: 'draft',
        slug: this.generateSlug(),
        creator_id: userId,
        updater_id: userId,
        created_at: now,
        updated_at: now,
      },
    });

    // 2. Create draft version
    const version = await this.prisma.automation_versions.create({
      data: {
        automation_id: automation.id,
        number: 1,
        status: 'draft',
      },
    });

    // 3. Seed trigger step (non-deletable, non-cloneable — replyagent parity)
    const triggerStep = await this.prisma.automation_steps.create({
      data: {
        automation_version_id: version.id,
        slug: this.generateSlug(),
        type: 'trigger',
        title: trigger_step_name || 'Starting step',
        cloneable: false,
        deletable: false,
        linkable: true,
        properties: JSON.stringify({}),
      },
    });

    // 4. Default activity on trigger step (event=default, linkable so user can wire it)
    await this.prisma.automation_step_activities.create({
      data: {
        slug: this.generateSlug(),
        step_id: triggerStep.id,
        parent_id: null,
        event: 'default',
        properties: JSON.stringify({ event: 'default' }),
        order: 1,
        linkable: true,
      },
    });

    // 5. Point automation at the draft version
    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: { draft_version_id: version.id },
    });

    return {
      success: true,
      automation: updated,
      message: 'Automation created',
    };
  }

  /**
   * Update automation (rename / move folder) — replyagent parity.
   * Sets updater_id only (creator_id stays immutable).
   */
  async updateAutomation(
    workspaceId: bigint,
    userId: bigint,
    automationId: bigint,
    data: any,
  ) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const updateData: any = { updater_id: userId, updated_at: new Date() };
    if (typeof data.name !== 'undefined') updateData.name = data.name;
    if (typeof data.folder_id !== 'undefined') {
      updateData.folder_id = data.folder_id ? BigInt(data.folder_id) : null;
    }

    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: updateData,
    });

    return { success: true, automation: updated, message: 'Automation updated' };
  }

  /**
   * Activate automation — replyagent parity.
   */
  async activateAutomation(workspaceId: bigint, userId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: { status: 'active', updater_id: userId, updated_at: new Date() },
    });

    return { success: true, automation: updated };
  }

  /**
   * Unpublish automation — replyagent parity (Automation::unPublishIt).
   * - Sets status = 'unpublished'
   * - Clears published_version_id (this is the critical step we were missing — the
   *   live version pointer must go to null so channels stop dispatching to it)
   * - Unlinks any channel auto-reply that points at this automation (replyagent's
   *   removeAutomationConnection call from unPublishAutomation)
   */
  async unPublishAutomation(workspaceId: bigint, userId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: {
        status: 'unpublished',
        published_version_id: null,
        updater_id: userId,
        updated_at: new Date(),
      },
    });

    await this.removeChannelAutoReply(automation.id);

    return { success: true, automation: updated };
  }

  /**
   * Soft delete automation — replyagent parity (Automation::deleteIt).
   * - Sets status = 'delete' (so any cached/in-flight reads see the terminal state)
   * - Sets deleted_at (Eloquent SoftDeletes equivalent)
   * - Unlinks any channel auto-reply pointing at this automation
   */
  async deleteAutomation(workspaceId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const now = new Date();
    await this.prisma.automations.update({
      where: { id: automation.id },
      data: {
        status: 'delete',
        deleted_at: now,
        updated_at: now,
      },
    });

    await this.removeChannelAutoReply(automation.id);

    return { success: true, message: 'Automation deleted' };
  }

  /**
   * Unlink this automation from every channel's auto-reply slot.
   * Replyagent's Automation::removeAutomationConnection does this across:
   * - instagram_features / facebook_features (morph) — not present in EZCONN schema, skipped
   * - telegram_bots.auto_reply_automation_id
   * - whatsapp_numbers.auto_reply_automation_id (replyagent's name; EZCONN splits into
   *   wa_accounts + wa_phone_numbers + zapi_instances + evolution_instances)
   *
   * Also covers fb_pages and insta_pages, since EZCONN exposes those columns directly.
   * Each updateMany is independent — silently skips if 0 rows match.
   */
  private async removeChannelAutoReply(automationId: bigint) {
    const data = { auto_reply_automation_id: null };
    await Promise.all([
      this.prisma.telegram_bots.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
      this.prisma.fb_pages.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
      this.prisma.insta_pages.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
      this.prisma.wa_accounts.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
      this.prisma.wa_phone_numbers.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
      this.prisma.zapi_instances.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
      this.prisma.evolution_instances.updateMany({
        where: { auto_reply_automation_id: automationId },
        data,
      }),
    ]);
  }

  /**
   * Duplicate automation — replyagent parity. Source is published version if available,
   * else draft. Steps + activities are cloned with fresh slugs (so connections in the
   * source don't collide with the copy). NOTE: automation_flows (connections) table
   * doesn't exist in the schema yet, so connections aren't cloned — manual wiring
   * needed in the copy until that's added.
   */
  async duplicateAutomation(
    workspaceId: bigint,
    userId: bigint,
    automationId: bigint,
    data: any = {},
  ) {
    const original = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId },
    });
    if (!original) throw new NotFoundException('Original automation not found');

    // Prefer published version as source (replyagent parity); fall back to draft
    let sourceVersionId = original.published_version_id || original.draft_version_id;
    if (!sourceVersionId) {
      throw new BadRequestException('Original has no version to clone');
    }

    const sourceVersion = await this.prisma.automation_versions.findUnique({
      where: { id: sourceVersionId },
    });
    if (!sourceVersion) throw new NotFoundException('Source version not found');

    // Fetch source steps + activities separately (no Prisma relation defined)
    const sourceSteps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: sourceVersion.id, deleted_at: null },
      orderBy: { id: 'asc' },
    });
    const sourceStepIds = sourceSteps.map((s: any) => s.id);
    const sourceActivities = sourceStepIds.length
      ? await this.prisma.automation_step_activities.findMany({
          where: { step_id: { in: sourceStepIds }, deleted_at: null },
          orderBy: { order: 'asc' },
        })
      : [];
    const activitiesByStep = new Map<string, any[]>();
    for (const a of sourceActivities) {
      const key = a.step_id.toString();
      if (!activitiesByStep.has(key)) activitiesByStep.set(key, []);
      activitiesByStep.get(key)!.push(a);
    }

    // 1. Create new automation with creator/updater + slug + timestamps
    const newName = data.name?.trim() || `${original.name} (Copy)`;
    const now = new Date();
    const copy = await this.prisma.automations.create({
      data: {
        workspace_id: workspaceId,
        name: newName,
        folder_id: original.folder_id,
        status: 'draft',
        slug: this.generateSlug(),
        creator_id: userId,
        updater_id: userId,
        created_at: now,
        updated_at: now,
      },
    });

    // 2. New draft version
    const newVersion = await this.prisma.automation_versions.create({
      data: {
        automation_id: copy.id,
        number: 1,
        status: 'draft',
      },
    });

    // 3. Clone each step + its activities with FRESH slugs
    for (const step of sourceSteps as any[]) {
      const newStep = await this.prisma.automation_steps.create({
        data: {
          automation_version_id: newVersion.id,
          slug: this.generateSlug(),
          title: step.title,
          type: step.type,
          properties: step.properties,
          cloneable: step.cloneable,
          deletable: step.deletable,
          linkable: step.linkable,
          comment: step.comment,
        },
      });

      // Clone activities (flat — parent_id remap requires 2-pass; skipped here since
      // step builder UI lets users re-nest. TODO when automation_flows lands.)
      const sourceStepActivities = activitiesByStep.get(step.id.toString()) || [];
      for (const activity of sourceStepActivities) {
        await this.prisma.automation_step_activities.create({
          data: {
            slug: this.generateSlug(),
            step_id: newStep.id,
            parent_id: null,
            event: activity.event,
            properties: activity.properties,
            order: activity.order,
            linkable: activity.linkable,
          },
        });
      }
    }

    const updated = await this.prisma.automations.update({
      where: { id: copy.id },
      data: { draft_version_id: newVersion.id },
    });

    return { success: true, automation: updated };
  }

  /**
   * Publish automation — replyagent parity. Clones draft version → new published version
   * (with its own step copies and fresh slugs), points automation at it, sets
   * publisher_id + published_at on the new version + updater_id on the automation.
   */
  async publishAutomation(workspaceId: bigint, userId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId },
    });

    if (!automation || !automation.draft_version_id) {
      throw new BadRequestException('No draft version to publish');
    }

    const draftVersion = await this.prisma.automation_versions.findUnique({
      where: { id: BigInt(automation.draft_version_id) },
    });
    if (!draftVersion) throw new NotFoundException('Draft version not found');

    // Fetch draft steps + activities separately (no Prisma relation defined)
    const draftSteps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: draftVersion.id, deleted_at: null },
      orderBy: { id: 'asc' },
    });
    const draftStepIds = draftSteps.map((s: any) => s.id);
    const draftActivities = draftStepIds.length
      ? await this.prisma.automation_step_activities.findMany({
          where: { step_id: { in: draftStepIds }, deleted_at: null },
          orderBy: { order: 'asc' },
        })
      : [];
    const activitiesByStep = new Map<string, any[]>();
    for (const a of draftActivities) {
      const key = a.step_id.toString();
      if (!activitiesByStep.has(key)) activitiesByStep.set(key, []);
      activitiesByStep.get(key)!.push(a);
    }

    // New published version
    const liveVersion = await this.prisma.automation_versions.create({
      data: {
        automation_id: automation.id,
        number:
          (await this.prisma.automation_versions.count({
            where: { automation_id: automation.id },
          })) + 1,
        status: 'published',
        publisher_id: userId,
        published_at: new Date(),
      },
    });

    // Clone each step + activities with fresh slugs (parity with duplicateAutomation)
    for (const step of draftSteps as any[]) {
      const newStep = await this.prisma.automation_steps.create({
        data: {
          automation_version_id: liveVersion.id,
          slug: this.generateSlug(),
          title: step.title,
          type: step.type,
          properties: step.properties,
          cloneable: step.cloneable,
          deletable: step.deletable,
          linkable: step.linkable,
          comment: step.comment,
        },
      });

      const stepActivitiesToClone = activitiesByStep.get(step.id.toString()) || [];
      for (const activity of stepActivitiesToClone) {
        await this.prisma.automation_step_activities.create({
          data: {
            slug: this.generateSlug(),
            step_id: newStep.id,
            parent_id: null, // see duplicateAutomation note on parent remap
            event: activity.event,
            properties: activity.properties,
            order: activity.order,
            linkable: activity.linkable,
          },
        });
      }
    }

    await this.prisma.automations.update({
      where: { id: automation.id },
      data: {
        published_version_id: liveVersion.id,
        status: 'active',
        updater_id: userId,
        updated_at: new Date(),
      },
    });

    return { success: true, live_version_id: liveVersion.id };
  }

  /**
   * Step management — replyagent parity (AutomationsController::createStep).
   * Each step type has its own cloneable/deletable/linkable defaults + auto-seeded
   * activities (e.g. randomizer gets 50/50 A/B activities, condition gets if-clause,
   * delay gets duration template, etc.).
   */
  async createStep(versionId: bigint, data: any) {
    if (!data?.type) throw new BadRequestException('type is required');
    if (!data?.title) throw new BadRequestException('title is required');

    // Resolve type-specific defaults (mirror of replyagent's switch)
    let cloneable = true;
    let deletable = true;
    let linkable = true;
    const activities: any[] = [];

    switch (data.type) {
      case 'trigger':
        cloneable = false;
        deletable = false;
        linkable = true;
        break;

      case 'randomizer':
        linkable = false;
        activities.push(
          { properties: { label: 'A', value: 50 }, linkable: true },
          { properties: { label: 'B', value: 50 }, linkable: true },
        );
        break;

      case 'condition':
        linkable = false;
        activities.push({
          order: 9999,
          properties: {
            action: null,
            check: 'if',
            matches: 'none',
            conditions: [],
          },
          linkable: true,
        });
        break;

      case 'delay':
        linkable = true;
        activities.push({
          properties: {
            type: 'duration',
            duration: {
              value: '1',
              unit: 'minutes',
              set_time_limit: false,
              between_from: '08:00',
              between_to: '18:00',
              days: [
                { day: 'monday', selected: true },
                { day: 'tuesday', selected: true },
                { day: 'wednesday', selected: true },
                { day: 'thursday', selected: true },
                { day: 'friday', selected: true },
                { day: 'saturday', selected: false },
                { day: 'sunday', selected: false },
              ],
            },
            date: { date_time: '' },
          },
          linkable: false,
        });
        break;

      case 'splitter':
        linkable = false;
        activities.push(
          { properties: { label: 'A', value: 'a' }, linkable: true },
          { properties: { label: 'B', value: 'b' }, linkable: true },
        );
        break;

      case 'twilio_voice':
        linkable = false;
        activities.push(
          { order: 1, properties: { type: 'completed' }, linkable: true },
          { order: 2, properties: { type: 'failed' }, linkable: true },
        );
        break;

      case 'start_automation':
        cloneable = false;
        deletable = true;
        linkable = true;
        activities.push({
          order: 1,
          properties: { automation_id: null, automation_name: null },
          linkable: false,
        });
        break;

      // action / telegram / whatsapp / messenger / instagram / twilio_sms / twilio_call
      // default: cloneable=true, deletable=true, linkable=true, no auto-activities
      default:
        break;
    }

    const step = await this.prisma.automation_steps.create({
      data: {
        automation_version_id: versionId,
        slug: this.generateSlug(),
        type: data.type,
        title: data.title,
        cloneable,
        deletable,
        linkable,
        properties: data.properties ? JSON.stringify(data.properties) : JSON.stringify({}),
      },
    });

    // Seed activities
    for (const activity of activities) {
      await this.prisma.automation_step_activities.create({
        data: {
          slug: this.generateSlug(),
          step_id: step.id,
          parent_id: null,
          event: activity.event ?? null,
          properties: JSON.stringify(activity.properties || {}),
          order: activity.order ?? 0,
          linkable: !!activity.linkable,
        },
      });
    }

    // Re-fetch with activities (no Prisma relation — separate query)
    const fresh = await this.prisma.automation_steps.findUnique({
      where: { id: step.id },
    });
    const freshActivities = await this.prisma.automation_step_activities.findMany({
      where: { step_id: step.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });

    return {
      success: true,
      step: { ...fresh, automation_step_activities: freshActivities },
    };
  }

  async updateStep(stepId: bigint, data: any) {
    const updateData: any = {};
    if (typeof data.title !== 'undefined') updateData.title = data.title;
    if (typeof data.linkable !== 'undefined') updateData.linkable = !!data.linkable;
    if (typeof data.properties !== 'undefined') {
      updateData.properties =
        typeof data.properties === 'string'
          ? data.properties
          : JSON.stringify(data.properties);
    }
    if (typeof data.comment !== 'undefined') updateData.comment = data.comment;

    const step = await this.prisma.automation_steps.update({
      where: { id: stepId },
      data: updateData,
    });
    return { success: true, step };
  }

  /**
   * Soft delete a step — replyagent's AutomationStep::deleteIt cascades to:
   * - All activities (and their descendants + their flow connectors)
   * - All quick replies (and their flow connectors)
   * - All flows where this step is the connector (TO) or the next step (FROM)
   * Without these cascades the canvas is left with dangling edges + ghost activities.
   */
  async deleteStep(stepId: bigint) {
    const step = await this.prisma.automation_steps.findUnique({
      where: { id: stepId },
    });
    if (!step) throw new BadRequestException('Invalid request');

    const now = new Date();

    // 1. Soft delete every activity under this step (and any descendants)
    const rootActivities = await this.prisma.automation_step_activities.findMany({
      where: { step_id: stepId, parent_id: null, deleted_at: null },
      select: { id: true },
    });
    for (const root of rootActivities) {
      const tree = await this.collectActivityTreeIds(root.id as any);
      await this.prisma.automation_step_activities.updateMany({
        where: { id: { in: tree } },
        data: { deleted_at: now },
      });
    }

    // 2. Soft delete quick replies on this step + their flow connectors
    const qrIds = (
      await this.prisma.automation_quick_replies.findMany({
        where: { automation_step_id: stepId, deleted_at: null },
        select: { id: true },
      })
    ).map((q: any) => q.id);
    if (qrIds.length > 0) {
      await this.prisma.automation_quick_replies.updateMany({
        where: { id: { in: qrIds } },
        data: { deleted_at: now },
      });
      await this.prisma.automation_flow.updateMany({
        where: {
          connector_id: { in: qrIds },
          connector_type: 'App\\Models\\Automations\\AutomationQuickReply',
          deleted_at: null,
        },
        data: { deleted_at: now },
      });
    }

    // 3. Soft delete flows where this step is the connector (TO) or next_step (FROM)
    await this.prisma.automation_flow.updateMany({
      where: {
        OR: [
          {
            connector_id: stepId,
            connector_type: 'App\\Models\\Automations\\AutomationStep',
          },
          { next_step_id: stepId },
        ],
        deleted_at: null,
      },
      data: { deleted_at: now },
    });

    // 4. Soft delete the step itself
    await this.prisma.automation_steps.update({
      where: { id: stepId },
      data: { deleted_at: now },
    });

    return { success: true };
  }

  // ─── Folder Management ───────────────────────────────────────────────
  // Replyagent parity (AutomationsController::createFolder / getFolders /
  // changeFolder / deleteFolder). Folders are workspace-scoped.

  async getFolders(workspaceId: bigint) {
    const folders = await this.prisma.automation_folders.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { id: 'asc' },
    });
    return { success: true, folders };
  }

  /**
   * Create OR update folder — replyagent uses one endpoint for both. If `id` is
   * provided in the body, it's an update; otherwise create.
   */
  async createOrUpdateFolder(workspaceId: bigint, data: any) {
    const name = data?.name?.trim();
    if (!name) throw new BadRequestException('Folder name is required');

    if (data.id) {
      const existing = await this.prisma.automation_folders.findFirst({
        where: { id: BigInt(data.id), workspace_id: workspaceId },
      });
      if (!existing) throw new NotFoundException('Folder not found');

      const updated = await this.prisma.automation_folders.update({
        where: { id: existing.id },
        data: { name },
      });
      return { success: true, folder: updated };
    }

    const folder = await this.prisma.automation_folders.create({
      data: {
        workspace_id: workspaceId,
        name,
      },
    });
    return { success: true, folder };
  }

  /**
   * Move an automation to a different folder — replyagent parity (changeFolder).
   */
  async changeFolder(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.folder_id || !data?.automation_id) {
      throw new BadRequestException('folder_id and automation_id are required');
    }

    const automation = await this.prisma.automations.findFirst({
      where: { id: BigInt(data.automation_id), workspace_id: workspaceId },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const folder = await this.prisma.automation_folders.findFirst({
      where: { id: BigInt(data.folder_id), workspace_id: workspaceId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: { folder_id: folder.id, updater_id: userId, updated_at: new Date() },
    });

    return { success: true, automation: updated };
  }

  /**
   * Delete folder — replyagent parity: only allowed if no automations point at it.
   */
  async deleteFolder(workspaceId: bigint, folderId: bigint) {
    const folder = await this.prisma.automation_folders.findFirst({
      where: { id: folderId, workspace_id: workspaceId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const automationsInFolder = await this.prisma.automations.findMany({
      where: { folder_id: folderId, deleted_at: null },
      select: { id: true, name: true, status: true },
    });
    if (automationsInFolder.length > 0) {
      throw new BadRequestException({
        code: 'HAS_AUTOMATIONS',
        message: 'Folder contains automations',
        automations: automationsInFolder,
      });
    }

    await this.prisma.automation_folders.delete({ where: { id: folder.id } });
    return { success: true };
  }

  // ─── Connection (AutomationFlow) Management ─────────────────────────
  // Replyagent parity (AutomationsController::saveConnection / deleteConnection).
  // connector_type matches replyagent's stored PHP class names for cross-system
  // compatibility. Frontend can send short keys ("step"/"activity"/"quick_reply"); we
  // normalize them.

  private resolveConnectorType(input: string): string {
    switch (input) {
      case 'activity':
        return 'App\\Models\\Automations\\AutomationStepActivity';
      case 'quick_reply':
        return 'App\\Models\\Automations\\AutomationQuickReply';
      default:
        return 'App\\Models\\Automations\\AutomationStep';
    }
  }

  /**
   * Create or update a connection (visual edge) between connector → next step.
   * Replyagent upserts on (connector_id, next_step_id, automation_version_id, connector_type).
   */
  async saveConnection(versionId: bigint, data: any) {
    if (!data?.connector_id || !data?.next_step_id || !data?.connector_type) {
      throw new BadRequestException('connector_id, next_step_id, connector_type are required');
    }

    const connectorType = this.resolveConnectorType(data.connector_type);
    const connectorId = BigInt(data.connector_id);
    const nextStepId = BigInt(data.next_step_id);

    // Verify the connector exists (replyagent does this in line 1617-1619)
    let exists = false;
    if (connectorType.endsWith('AutomationStepActivity')) {
      exists = !!(await this.prisma.automation_step_activities.findUnique({
        where: { id: connectorId },
      }));
    } else if (connectorType.endsWith('AutomationQuickReply')) {
      exists = !!(await this.prisma.automation_quick_replies.findUnique({
        where: { id: connectorId },
      }));
    } else {
      exists = !!(await this.prisma.automation_steps.findUnique({
        where: { id: connectorId },
      }));
    }
    if (!exists) throw new BadRequestException('Invalid connector');

    const existing = await this.prisma.automation_flow.findFirst({
      where: {
        connector_id: connectorId,
        next_step_id: nextStepId,
        automation_version_id: versionId,
        connector_type: connectorType,
        deleted_at: null,
      },
    });

    let connection: any;
    if (existing) {
      connection = await this.prisma.automation_flow.update({
        where: { id: existing.id },
        data: {
          connector_id: connectorId,
          next_step_id: nextStepId,
          connector_type: connectorType,
        },
      });
    } else {
      connection = await this.prisma.automation_flow.create({
        data: {
          slug: this.generateSlug(),
          connector_id: connectorId,
          next_step_id: nextStepId,
          automation_version_id: versionId,
          connector_type: connectorType,
        },
      });
    }

    // Replyagent returns connector_step + connection + next_step (deeply loaded).
    // Without Prisma relations we just return what we have; frontend can re-fetch the
    // automation if it needs the full tree.
    return { success: true, connection };
  }

  async deleteConnection(versionId: bigint, flowId: bigint) {
    const flow = await this.prisma.automation_flow.findFirst({
      where: { id: flowId, automation_version_id: versionId },
    });
    if (!flow) throw new BadRequestException('Invalid request');
    await this.prisma.automation_flow.delete({ where: { id: flow.id } });
    return { success: true };
  }

  /**
   * Replyagent's getAutomationConnections returns the automation with related
   * channel-features (instagramFeatures, facebookFeatures, etc.). Those features
   * aren't wired into NestJS yet — we return the automation + its automation_flow
   * rows for the published or draft version so the frontend can show connections.
   */
  async getAutomationConnections(workspaceId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new BadRequestException('Invalid request');

    const versionId = automation.published_version_id || automation.draft_version_id;
    const flows = versionId
      ? await this.prisma.automation_flow.findMany({
          where: { automation_version_id: versionId, deleted_at: null },
        })
      : [];

    return { success: true, data: { ...automation, flows } };
  }

  // ─── Step Activities CRUD ──────────────────────────────────────────
  // Replyagent: createStepActivity (single, with type-specific child seeding),
  // createStepActivities (batch with nesting), updateStepActivity, deleteActivity,
  // deleteStepActivities, saveActivitiesOrder, restoreActivity.

  /**
   * Create a single step activity — mirrors replyagent's createStepActivity which
   * auto-seeds child activities for certain `properties.type` values (input,
   * chatgpt_question, dify_question, twilio_recorded_call, twilio_live_call, otn).
   */
  async createStepActivity(data: any) {
    if (!data?.step_id) throw new BadRequestException('step_id is required');
    if (!data?.properties) throw new BadRequestException('properties is required');

    const step = await this.prisma.automation_steps.findUnique({
      where: { id: BigInt(data.step_id) },
    });
    if (!step) throw new BadRequestException('Invalid request');

    const properties = data.properties || {};
    const event =
      data.event ?? (typeof properties === 'object' ? properties.event ?? null : null);

    const activity = await this.prisma.automation_step_activities.create({
      data: {
        slug: this.generateSlug(),
        step_id: BigInt(data.step_id),
        parent_id: data.parent_id ? BigInt(data.parent_id) : null,
        event: event ?? null,
        properties: JSON.stringify(properties),
        order: data.order ? Number(data.order) : 0,
        linkable: data.linkable ? true : false,
      },
    });

    // Type-specific child activity seeding (replyagent parity, lines 1253-1404)
    const type = typeof properties === 'object' ? properties.type : null;
    const childSeeds: any[] = [];
    if (type === 'input') {
      childSeeds.push(
        { event: null, props: { type: 'input_options', event: 'responded' }, order: 1, linkable: true },
        { event: null, props: { type: 'input_options', event: 'no_response' }, order: 2, linkable: true },
      );
    } else if (type === 'chatgpt_question' || type === 'dify_question') {
      childSeeds.push(
        { event: null, props: { type: 'input_options', event: 'answer_failed' }, order: 1, linkable: true },
        { event: null, props: { type: 'input_options', event: 'no_further_question' }, order: 1, linkable: true },
      );
    } else if (type === 'chatgpt_action') {
      childSeeds.push({
        event: 'gpt_answer_failed',
        props: { type: 'gpt_answer_failed', event: 'answer_failed' },
        order: 1,
        linkable: true,
      });
    } else if (type === 'twilio_recorded_call') {
      for (const status of ['completed', 'failed']) {
        childSeeds.push({
          event: `call_${status}`,
          props: { type: `call_${status}` },
          order: 1,
          linkable: true,
        });
      }
    } else if (type === 'twilio_live_call') {
      for (const status of ['completed', 'canceled', 'busy', 'no-answer', 'failed']) {
        childSeeds.push({
          event: `call_${status}`,
          props: { type: `call_${status}` },
          order: 1,
          linkable: true,
        });
      }
    } else if (type === 'otn') {
      childSeeds.push(
        { event: 'fb_topic_subscribed', props: { type: 'fb_topic_options', event: 'fb_topic_subscribed' }, order: 1, linkable: true },
        { event: 'fb_topic_sent', props: { type: 'fb_topic_options', event: 'fb_topic_sent' }, order: 2, linkable: true },
        { event: 'fb_topic_limit_reach', props: { type: 'fb_topic_options', event: 'fb_topic_limit_reach' }, order: 2, linkable: true },
      );
    }

    for (const seed of childSeeds) {
      await this.prisma.automation_step_activities.create({
        data: {
          slug: this.generateSlug(),
          step_id: activity.step_id,
          parent_id: activity.id,
          event: seed.event,
          properties: JSON.stringify(seed.props),
          order: seed.order,
          linkable: seed.linkable,
        },
      });
    }

    // Recursively create children if provided in the request (replyagent line 1409-1430)
    if (Array.isArray(data.children) && data.children.length > 0) {
      await this.createChildActivities(data.children, activity);
    }

    // Re-fetch with children
    const children = await this.prisma.automation_step_activities.findMany({
      where: { parent_id: activity.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });

    return { ...activity, children };
  }

  private async createChildActivities(children: any[], parent: any) {
    for (const child of children) {
      const created = await this.prisma.automation_step_activities.create({
        data: {
          slug: this.generateSlug(),
          step_id: parent.step_id,
          parent_id: parent.id,
          event: child.event || null,
          properties: JSON.stringify(child.properties || {}),
          order: child.order ? Number(child.order) : 0,
          linkable: !!child.linkable,
        },
      });
      if (Array.isArray(child.children) && child.children.length > 0) {
        await this.createChildActivities(child.children, created);
      }
    }
  }

  /**
   * Bulk create activities on a step (with nesting) — replyagent createStepActivities.
   */
  async createStepActivities(stepId: bigint, activities: any[]) {
    const step = await this.prisma.automation_steps.findUnique({ where: { id: stepId } });
    if (!step) throw new BadRequestException('Invalid request');
    if (!Array.isArray(activities)) {
      throw new BadRequestException('activities array required');
    }

    const createRecursive = async (items: any[], parentId: bigint | null) => {
      for (const item of items) {
        const created = await this.prisma.automation_step_activities.create({
          data: {
            slug: item.slug || this.generateSlug(),
            step_id: stepId,
            parent_id: parentId,
            event: item.event || null,
            properties: JSON.stringify(item.properties || {}),
            order: item.order ? Number(item.order) : 0,
            linkable: !!item.linkable,
          },
        });
        if (Array.isArray(item.children) && item.children.length > 0) {
          await createRecursive(item.children, created.id);
        }
      }
    };
    await createRecursive(activities, null);

    const allActivities = await this.prisma.automation_step_activities.findMany({
      where: { step_id: stepId, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    return { success: true, step: { ...step, automation_step_activities: allActivities } };
  }

  /**
   * Update an activity's properties / linkable + optionally rewrite its children tree.
   * Replyagent's updateStepActivity supports adding/updating/deleting children in one call.
   */
  async updateStepActivity(activityId: bigint, data: any) {
    const activity = await this.prisma.automation_step_activities.findUnique({
      where: { id: activityId },
    });
    if (!activity) throw new BadRequestException('Invalid request');

    const updateData: any = {};
    if (typeof data.properties !== 'undefined') {
      updateData.properties =
        typeof data.properties === 'string'
          ? data.properties
          : JSON.stringify(data.properties);
    }
    if (typeof data.linkable !== 'undefined') updateData.linkable = !!data.linkable;
    if (typeof data.event !== 'undefined') updateData.event = data.event;
    if (typeof data.order !== 'undefined') updateData.order = Number(data.order);

    await this.prisma.automation_step_activities.update({
      where: { id: activity.id },
      data: updateData,
    });

    // Children rewrite (replyagent line 1483-1532)
    if (Array.isArray(data.children)) {
      await this.rewriteChildren(activity.id, activity.step_id, data.children);
    }

    const fresh = await this.prisma.automation_step_activities.findUnique({
      where: { id: activity.id },
    });
    const children = await this.prisma.automation_step_activities.findMany({
      where: { parent_id: activity.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    return { ...fresh, children };
  }

  private async rewriteChildren(parentId: bigint, stepId: bigint, incoming: any[]) {
    const keptIds: bigint[] = [];
    for (const child of incoming) {
      let childRow: any;
      if (child.id) {
        // Update existing
        const existing = await this.prisma.automation_step_activities.findUnique({
          where: { id: BigInt(child.id) },
        });
        if (!existing) continue;
        childRow = await this.prisma.automation_step_activities.update({
          where: { id: existing.id },
          data: {
            properties:
              typeof child.properties !== 'undefined'
                ? typeof child.properties === 'string'
                  ? child.properties
                  : JSON.stringify(child.properties)
                : existing.properties,
          },
        });
      } else {
        // Create new
        childRow = await this.prisma.automation_step_activities.create({
          data: {
            slug: this.generateSlug(),
            step_id: stepId,
            parent_id: parentId,
            event: child.event || null,
            properties: JSON.stringify(child.properties || {}),
            order: child.order ? Number(child.order) : 0,
            linkable: !!child.linkable,
          },
        });
      }
      keptIds.push(childRow.id);
      if (Array.isArray(child.children) && child.children.length > 0) {
        await this.rewriteChildren(childRow.id, stepId, child.children);
      }
    }

    // Soft-delete any children that weren't in `incoming`
    const toDelete = await this.prisma.automation_step_activities.findMany({
      where: {
        parent_id: parentId,
        deleted_at: null,
        ...(keptIds.length > 0 ? { id: { notIn: keptIds } } : {}),
      },
      select: { id: true },
    });
    if (toDelete.length > 0) {
      await this.prisma.automation_step_activities.updateMany({
        where: { id: { in: toDelete.map((a: any) => a.id) } },
        data: { deleted_at: new Date() },
      });
    }
  }

  /**
   * Soft delete activity (and descendants) — replyagent parity.
   * @param reorder when true, the surviving siblings of this activity are renumbered
   *                1..N (replyagent's AutomationStepActivity::reorderChildren). Frontend
   *                passes ?reorder=1 when removing a node from an ordered list (e.g.
   *                quick-reply options) so display order stays contiguous.
   */
  async deleteActivity(activityId: bigint, reorder = false) {
    const activity = await this.prisma.automation_step_activities.findUnique({
      where: { id: activityId },
    });
    if (!activity) throw new BadRequestException('Invalid request');

    const now = new Date();

    // Delete its connection flows (replyagent line 1741-1743)
    await this.prisma.automation_flow.updateMany({
      where: {
        connector_id: activity.id,
        connector_type: 'App\\Models\\Automations\\AutomationStepActivity',
        deleted_at: null,
      },
      data: { deleted_at: now },
    });

    // Soft delete activity + its descendants (collect tree iteratively)
    const allIds = await this.collectActivityTreeIds(activity.id);
    await this.prisma.automation_step_activities.updateMany({
      where: { id: { in: allIds } },
      data: { deleted_at: now },
    });

    // Optional sibling reorder (replyagent's reorderChildren — renumbers 1..N)
    if (reorder) {
      const siblings = await this.prisma.automation_step_activities.findMany({
        where: {
          step_id: activity.step_id,
          parent_id: activity.parent_id,
          id: { not: activity.id },
          deleted_at: null,
        },
        orderBy: { order: 'asc' },
        select: { id: true },
      });
      let nextOrder = 1;
      for (const sibling of siblings) {
        await this.prisma.automation_step_activities.update({
          where: { id: sibling.id },
          data: { order: nextOrder++ },
        });
      }
    }

    return { success: true };
  }

  private async collectActivityTreeIds(rootId: bigint): Promise<bigint[]> {
    const ids: bigint[] = [rootId];
    let frontier: bigint[] = [rootId];
    while (frontier.length > 0) {
      const children = await this.prisma.automation_step_activities.findMany({
        where: { parent_id: { in: frontier }, deleted_at: null },
        select: { id: true },
      });
      const childIds = children.map((c: any) => c.id);
      ids.push(...childIds);
      frontier = childIds;
    }
    return ids;
  }

  async deleteStepActivities(stepId: bigint) {
    const rootActivities = await this.prisma.automation_step_activities.findMany({
      where: { step_id: stepId, parent_id: null, deleted_at: null },
      select: { id: true },
    });
    for (const root of rootActivities) {
      await this.deleteActivity(root.id as any);
    }
    return { success: true };
  }

  async saveActivitiesOrder(activities: any[]) {
    if (!Array.isArray(activities)) {
      throw new BadRequestException('activities array required');
    }
    for (const row of activities) {
      if (row?.id && typeof row.order !== 'undefined') {
        await this.prisma.automation_step_activities.update({
          where: { id: BigInt(row.id) },
          data: { order: Number(row.order) },
        });
      }
    }
    return { success: true, message: 'successfully updated' };
  }

  async restoreActivity(activityId: bigint) {
    const activity = await this.prisma.automation_step_activities.findFirst({
      where: { id: activityId },
    });
    if (!activity) throw new BadRequestException('Invalid request');

    await this.prisma.automation_step_activities.update({
      where: { id: activity.id },
      data: { deleted_at: null },
    });
    const fresh = await this.prisma.automation_step_activities.findUnique({
      where: { id: activity.id },
    });
    return fresh;
  }

  // ─── Multi-step Operations ─────────────────────────────────────────

  async deleteSteps(stepIds: any[]) {
    if (!Array.isArray(stepIds) || stepIds.length === 0) {
      throw new BadRequestException('steps array required');
    }
    const ids = stepIds.map((id) => BigInt(id));
    // Soft delete steps + their activities + their flow connections
    await this.prisma.automation_steps.updateMany({
      where: { id: { in: ids } },
      data: { deleted_at: new Date() },
    });
    await this.prisma.automation_step_activities.updateMany({
      where: { step_id: { in: ids } },
      data: { deleted_at: new Date() },
    });
    await this.prisma.automation_flow.updateMany({
      where: {
        OR: [
          { connector_id: { in: ids }, connector_type: 'App\\Models\\Automations\\AutomationStep' },
          { next_step_id: { in: ids } },
        ],
        deleted_at: null,
      },
      data: { deleted_at: new Date() },
    });
    return { success: true };
  }

  async restoreSteps(stepIds: any[], withActivities: boolean) {
    if (!Array.isArray(stepIds) || stepIds.length === 0) {
      throw new BadRequestException('steps array required');
    }
    const ids = stepIds.map((id) => BigInt(id));
    await this.prisma.automation_steps.updateMany({
      where: { id: { in: ids } },
      data: { deleted_at: null },
    });
    if (withActivities) {
      await this.prisma.automation_step_activities.updateMany({
        where: { step_id: { in: ids } },
        data: { deleted_at: null },
      });
    }
    const steps = await this.prisma.automation_steps.findMany({
      where: { id: { in: ids } },
    });
    return { steps };
  }

  /**
   * Clone multiple steps within a version — replyagent's cloneSteps. Source steps +
   * their activities + their flows (between cloned steps) are duplicated with fresh
   * slugs. Cross-version connections are not remapped (replyagent's pattern too).
   */
  async cloneSteps(versionId: bigint, stepIds: any[]) {
    if (!Array.isArray(stepIds) || stepIds.length === 0) {
      throw new BadRequestException('steps array required');
    }
    const sourceIds = stepIds.map((id) => BigInt(id));
    const sourceSteps = await this.prisma.automation_steps.findMany({
      where: { id: { in: sourceIds } },
    });
    if (sourceSteps.length === 0) {
      throw new BadRequestException('No steps to clone');
    }

    const stepsMapping = new Map<string, bigint>();
    const activitiesMapping = new Map<string, bigint>();

    for (const step of sourceSteps as any[]) {
      const props = this.parseProperties(step.properties);
      const newProps = {
        ...props,
        x: (typeof props?.x === 'number' ? props.x : 200) + Math.floor(Math.random() * 100) + 320,
        y: (typeof props?.y === 'number' ? props.y : 200) + Math.floor(Math.random() * 200),
      };

      const newStep = await this.prisma.automation_steps.create({
        data: {
          automation_version_id: versionId,
          slug: this.generateSlug(),
          title: step.title,
          type: step.type,
          properties: JSON.stringify(newProps),
          cloneable: step.cloneable,
          deletable: step.deletable,
          linkable: step.linkable,
          comment: step.comment,
        },
      });
      stepsMapping.set(step.id.toString(), newStep.id);

      // Clone activities preserving parent relationships
      const sourceActivities = await this.prisma.automation_step_activities.findMany({
        where: { step_id: step.id, deleted_at: null },
        orderBy: { id: 'asc' },
      });

      // 2-pass: first create all activities, then fix parent_id
      const localActMap = new Map<string, bigint>();
      for (const act of sourceActivities as any[]) {
        const newAct = await this.prisma.automation_step_activities.create({
          data: {
            slug: this.generateSlug(),
            step_id: newStep.id,
            parent_id: null, // pass 1
            event: act.event,
            properties: act.properties,
            order: act.order,
            linkable: act.linkable,
          },
        });
        localActMap.set(act.id.toString(), newAct.id);
        activitiesMapping.set(act.id.toString(), newAct.id);
      }
      // Pass 2: remap parent_id
      for (const act of sourceActivities as any[]) {
        if (act.parent_id) {
          const newParentId = localActMap.get(act.parent_id.toString());
          if (newParentId) {
            await this.prisma.automation_step_activities.update({
              where: { id: localActMap.get(act.id.toString()) },
              data: { parent_id: newParentId },
            });
          }
        }
      }
    }

    // Clone flows that fully live within the cloned set
    const sourceFlows = await this.prisma.automation_flow.findMany({
      where: {
        OR: [
          {
            connector_id: { in: sourceIds },
            connector_type: 'App\\Models\\Automations\\AutomationStep',
          },
          {
            connector_id: { in: [...activitiesMapping.keys()].map((k) => BigInt(k)) },
            connector_type: 'App\\Models\\Automations\\AutomationStepActivity',
          },
        ],
        next_step_id: { in: sourceIds },
        deleted_at: null,
      },
    });

    for (const flow of sourceFlows as any[]) {
      let newConnectorId: bigint | undefined;
      if (flow.connector_type === 'App\\Models\\Automations\\AutomationStep') {
        newConnectorId = stepsMapping.get(flow.connector_id.toString());
      } else if (flow.connector_type === 'App\\Models\\Automations\\AutomationStepActivity') {
        newConnectorId = activitiesMapping.get(flow.connector_id.toString());
      }
      const newNextStepId = stepsMapping.get(flow.next_step_id.toString());
      if (!newConnectorId || !newNextStepId) continue;

      await this.prisma.automation_flow.create({
        data: {
          automation_version_id: versionId,
          slug: this.generateSlug(),
          connector_id: newConnectorId,
          next_step_id: newNextStepId,
          connector_type: flow.connector_type,
        },
      });
    }

    const newStepIds = [...stepsMapping.values()];
    const steps = await this.prisma.automation_steps.findMany({
      where: { id: { in: newStepIds } },
    });
    return { steps };
  }

  private parseProperties(raw: any): any {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // ─── Quick Replies CRUD ────────────────────────────────────────────

  async addQuickReply(stepId: bigint, data: any) {
    const step = await this.prisma.automation_steps.findUnique({ where: { id: stepId } });
    if (!step) throw new BadRequestException('Invalid request');

    const qr = await this.prisma.automation_quick_replies.create({
      data: {
        automation_step_id: stepId,
        slug: this.generateSlug(),
        title: data?.title || '',
        order: data?.order ? Number(data.order) : 0,
      },
    });
    return qr;
  }

  async updateQuickReply(stepId: bigint, qrId: bigint, data: any) {
    const qr = await this.prisma.automation_quick_replies.findFirst({
      where: { id: qrId, automation_step_id: stepId },
    });
    if (!qr) throw new BadRequestException('Invalid request');

    const updated = await this.prisma.automation_quick_replies.update({
      where: { id: qr.id },
      data: {
        ...(typeof data.title !== 'undefined' ? { title: data.title } : {}),
        ...(typeof data.order !== 'undefined' ? { order: Number(data.order) } : {}),
      },
    });
    return updated;
  }

  async deleteQuickReply(stepId: bigint, qrId: bigint) {
    const qr = await this.prisma.automation_quick_replies.findFirst({
      where: { id: qrId, automation_step_id: stepId },
    });
    if (!qr) throw new BadRequestException('Invalid request');

    // Also clean up flow connections rooted at this QR
    await this.prisma.automation_flow.updateMany({
      where: {
        connector_id: qr.id,
        connector_type: 'App\\Models\\Automations\\AutomationQuickReply',
        deleted_at: null,
      },
      data: { deleted_at: new Date() },
    });
    await this.prisma.automation_quick_replies.delete({ where: { id: qr.id } });
    return { success: true };
  }

  // ─── Misc: toggleFeeder, checkTriggerText, validateKeywords ────────

  /**
   * Create a fresh draft from the published version — replyagent's "Edit" button on
   * an active flow. Live (published) version stays untouched until the new draft is
   * published, so contacts in-flight on the live version aren't broken.
   *
   * Mirrors the clone-version-data pattern used by duplicate/publish: fresh slugs
   * everywhere, 2-pass parent_id remap for activities, intra-set flow remap.
   */
  async createDraftFromPublished(
    workspaceId: bigint,
    userId: bigint,
    automationId: bigint,
  ) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new NotFoundException('Automation not found');
    if (!automation.published_version_id) {
      throw new BadRequestException('Automation has no published version to edit');
    }

    const publishedVersion = await this.prisma.automation_versions.findUnique({
      where: { id: automation.published_version_id as any },
    });
    if (!publishedVersion) throw new NotFoundException('Published version not found');

    // Fetch published source state
    const sourceSteps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: publishedVersion.id, deleted_at: null },
      orderBy: { id: 'asc' },
    });
    const sourceStepIds = sourceSteps.map((s: any) => s.id);
    const sourceActivities = sourceStepIds.length
      ? await this.prisma.automation_step_activities.findMany({
          where: { step_id: { in: sourceStepIds }, deleted_at: null },
          orderBy: { id: 'asc' },
        })
      : [];
    const sourceFlows = sourceStepIds.length
      ? await this.prisma.automation_flow.findMany({
          where: {
            automation_version_id: publishedVersion.id,
            deleted_at: null,
          },
        })
      : [];

    // 1. New draft version (number = (last version + 1))
    const lastNumber = await this.prisma.automation_versions.aggregate({
      where: { automation_id: automation.id },
      _max: { number: true },
    });
    const nextNumber = (lastNumber._max?.number ?? 0n) + 1n;
    const newVersion = await this.prisma.automation_versions.create({
      data: {
        automation_id: automation.id,
        number: nextNumber as any,
        status: 'draft',
      },
    });

    // 2. Clone steps (id remap)
    const stepIdMap = new Map<string, bigint>();
    for (const step of sourceSteps as any[]) {
      const newStep = await this.prisma.automation_steps.create({
        data: {
          automation_version_id: newVersion.id,
          slug: this.generateSlug(),
          title: step.title,
          type: step.type,
          properties: step.properties,
          cloneable: step.cloneable,
          deletable: step.deletable,
          linkable: step.linkable,
          comment: step.comment,
        },
      });
      stepIdMap.set(step.id.toString(), newStep.id);
    }

    // 3. Clone activities — pass 1 create flat, pass 2 remap parent_id
    const activityIdMap = new Map<string, bigint>();
    for (const act of sourceActivities as any[]) {
      const newStepId = stepIdMap.get(act.step_id.toString());
      if (!newStepId) continue;
      const newAct = await this.prisma.automation_step_activities.create({
        data: {
          slug: this.generateSlug(),
          step_id: newStepId,
          parent_id: null,
          event: act.event,
          properties: act.properties,
          order: act.order,
          linkable: act.linkable,
        },
      });
      activityIdMap.set(act.id.toString(), newAct.id);
    }
    for (const act of sourceActivities as any[]) {
      if (!act.parent_id) continue;
      const newId = activityIdMap.get(act.id.toString());
      const newParentId = activityIdMap.get(act.parent_id.toString());
      if (newId && newParentId) {
        await this.prisma.automation_step_activities.update({
          where: { id: newId },
          data: { parent_id: newParentId },
        });
      }
    }

    // 4. Clone flows with connector_id + next_step_id remap
    for (const flow of sourceFlows as any[]) {
      let newConnectorId: bigint | undefined;
      if (flow.connector_type === 'App\\Models\\Automations\\AutomationStep') {
        newConnectorId = stepIdMap.get(flow.connector_id.toString());
      } else if (flow.connector_type === 'App\\Models\\Automations\\AutomationStepActivity') {
        newConnectorId = activityIdMap.get(flow.connector_id.toString());
      }
      // (QuickReply remap omitted — quick replies aren't cloned here yet)
      const newNextStepId = stepIdMap.get(flow.next_step_id.toString());
      if (!newConnectorId || !newNextStepId) continue;

      await this.prisma.automation_flow.create({
        data: {
          automation_version_id: newVersion.id,
          slug: this.generateSlug(),
          connector_id: newConnectorId,
          next_step_id: newNextStepId,
          connector_type: flow.connector_type,
        },
      });
    }

    // 5. Point automation at new draft + bump updater
    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: {
        draft_version_id: newVersion.id,
        updater_id: userId,
        updated_at: new Date(),
      },
    });

    return {
      success: true,
      automation: updated,
      draft_version_id: newVersion.id,
      message: 'Editable draft created',
    };
  }

  /**
   * Clear all in-flight execution state for an automation — replyagent's
   * flushAutomationQueue. Deletes:
   *  - automation_queue rows pointing through this automation's steps
   *  - automation_runs rows for this automation
   *  - automation_activity_iterations rows for this automation's activities
   *  - ai_messages rows for this automation's activities
   *
   * Schema lacks Prisma relations on these tables — we fetch step/activity ids
   * first, then delete by `step_id IN (...)` / `activity_id IN (...)`.
   */
  async flushAutomationQueue(workspaceId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    // 1. Collect all version IDs for this automation
    const versions = await this.prisma.automation_versions.findMany({
      where: { automation_id: automation.id },
      select: { id: true },
    });
    const versionIds = versions.map((v: any) => v.id);
    if (versionIds.length === 0) {
      // No versions → nothing in queue. Still wipe runs to be safe.
      await this.prisma.automation_runs.deleteMany({
        where: { automation_id: automation.id },
      });
      return { success: true, message: 'Queue cleared' };
    }

    // 2. Collect all step IDs (including soft-deleted, because queue may still
    //    reference them)
    const steps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: { in: versionIds } },
      select: { id: true },
    });
    const stepIds = steps.map((s: any) => s.id);

    // 3. Collect all activity IDs
    const activities = stepIds.length
      ? await this.prisma.automation_step_activities.findMany({
          where: { step_id: { in: stepIds } },
          select: { id: true },
        })
      : [];
    const activityIds = activities.map((a: any) => a.id);

    // 4. Execute the 4 deletes concurrently
    const ops: Promise<any>[] = [
      this.prisma.automation_runs.deleteMany({
        where: { automation_id: automation.id },
      }),
    ];
    if (stepIds.length > 0) {
      ops.push(
        this.prisma.automation_queue.deleteMany({
          where: { step_id: { in: stepIds } },
        }),
      );
    }
    if (activityIds.length > 0) {
      ops.push(
        this.prisma.automation_activity_iterations.deleteMany({
          where: { activity_id: { in: activityIds } },
        }),
        this.prisma.ai_messages.deleteMany({
          where: { activity_id: { in: activityIds } },
        }),
      );
    }
    const results = await Promise.all(ops);
    const totalDeleted = results.reduce(
      (sum: number, r: any) => sum + (r?.count ?? 0),
      0,
    );

    return { success: true, message: 'Queue cleared', cleared: totalDeleted };
  }

  async toggleFeeder(workspaceId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const updated = await this.prisma.automations.update({
      where: { id: automation.id },
      data: { allow_in_feeder: !automation.allow_in_feeder, updated_at: new Date() },
    });
    return { success: true, allow_in_feeder: updated.allow_in_feeder };
  }

  /**
   * Check whether another PUBLISHED activity in this workspace already uses the same
   * trigger_text for the same event (so the user gets a duplicate-warning before save).
   * Mirrors replyagent's checkTriggerText exactly (only flags duplicates in OTHER
   * automations' published versions; excludes the current activity by id).
   */
  async checkTriggerText(
    workspaceId: bigint,
    automationId: bigint,
    activityId: bigint,
    data: any,
  ) {
    if (!data?.trigger_text || !data?.event) {
      throw new BadRequestException('trigger_text and event are required');
    }

    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new BadRequestException('Invalid request');

    // Raw query mirrors replyagent's join logic. We use Prisma raw for the JSON path.
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT asa.id, asa.step_id, asa.properties
      FROM automation_step_activities asa
      JOIN automation_steps as_ ON asa.step_id = as_.id
      JOIN automation_versions av ON av.id = as_.automation_version_id
      JOIN automations a ON av.automation_id = a.id
      WHERE a.workspace_id = ?
        AND asa.deleted_at IS NULL
        AND a.published_version_id IS NOT NULL
        AND av.id <> ?
        AND asa.event = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(asa.properties, '$.triggerText')) = ?
        AND asa.id <> ?
      LIMIT 1
      `,
      workspaceId.toString(),
      (automation.published_version_id || 0n).toString(),
      data.event,
      data.trigger_text,
      activityId.toString(),
    );

    const duplicate = rows && rows.length > 0 ? rows[0] : null;
    return {
      duplicate: !!duplicate,
      duplicate_activity_id: duplicate?.id ? duplicate.id.toString() : null,
    };
  }

  /**
   * Validate that none of the given keywords are already used by a `trigger` step's
   * activity for the same channel + modelable across this workspace. Replyagent uses
   * this to prevent two automations responding to the same keyword.
   */
  async validateKeywords(activityId: bigint, data: any) {
    const activity = await this.prisma.automation_step_activities.findUnique({
      where: { id: activityId },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    const automationId = data?.automation_id;
    const automation = automationId
      ? await this.prisma.automations.findUnique({ where: { id: BigInt(automationId) } })
      : null;
    if (!automation) throw new BadRequestException('automation_id required');

    const keywords: string[] = Array.isArray(data?.keywords) ? data.keywords : [];
    const modelableId = data?.channel_id;
    const channel = (data?.channel || '').toUpperCase();

    const eventByChannel: Record<string, { event: string; jsonField: string }> = {
      TELEGRAM: { event: 'telegram_keyword', jsonField: 'telegram_bot_id' },
      MESSENGER: { event: 'facebook_keyword', jsonField: 'fb_page_id' },
      WHATSAPP: { event: 'whatsapp_keyword', jsonField: 'wa_account_id' },
      ZAPI: { event: 'zapi_keyword', jsonField: 'instance_id' },
      INSTAGRAM: { event: 'instagram_keyword', jsonField: 'insta_page_id' },
      TWILIO: { event: 'twilio_keyword', jsonField: 'twilio_number_id' },
      WEBCHAT: { event: 'webchat_keyword', jsonField: 'instance_id' },
    };
    const channelCfg = eventByChannel[channel];
    if (!channelCfg) {
      return { success: true }; // Unknown channel — nothing to validate
    }

    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `
      SELECT asa.id, asa.properties, a.name AS automation_name
      FROM automation_step_activities asa
      JOIN automation_steps as_ ON asa.step_id = as_.id
      JOIN automations a ON (
        as_.automation_version_id = a.published_version_id
        OR as_.automation_version_id = a.draft_version_id
      )
      WHERE a.workspace_id = ?
        AND a.deleted_at IS NULL
        AND as_.type = 'trigger'
        AND asa.slug <> ?
        AND asa.deleted_at IS NULL
        AND asa.event = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(asa.properties, '$.${channelCfg.jsonField}')) = ?
      `,
      automation.workspace_id.toString(),
      activity.slug || '',
      channelCfg.event,
      String(modelableId ?? ''),
    );

    for (const row of rows || []) {
      const props = this.parseProperties(row.properties);
      const dbKeywords: string[] = Array.isArray(props?.keywords) ? props.keywords : [];
      const matches = dbKeywords.filter((k) => keywords.includes(k));
      if (matches.length > 0) {
        throw new BadRequestException({
          code: 'DUPLICATE_KEYWORD',
          keyword: matches.join(','),
          automation_name: row.automation_name,
        });
      }
    }

    return { success: true };
  }

  /**
   * Import an automation from a serialized export. Recreates the automation
   * + draft version + steps + activities + connections + quick replies,
   * remapping foreign slugs to fresh ones so multiple imports coexist.
   *
   * Mirrors replyagent's AutomationsController::import() — but lives in the
   * service so the controller stays thin.
   */
  async importAutomation(workspaceId: bigint, userId: bigint, payload: any) {
    if (!payload?.name) {
      throw new BadRequestException('name is required');
    }
    const now = new Date();

    // 1. Create the automation shell.
    const automation = await this.prisma.automations.create({
      data: {
        slug: this.generateSlug(),
        workspace_id: workspaceId,
        folder_id: payload.folder_id ? BigInt(payload.folder_id) : null,
        creator_id: userId,
        updater_id: userId,
        name: String(payload.name),
        status: 'draft',
        template: payload.template ?? '',
        message_template_namespace: '' as any,
        is_migrated: 0,
        created_at: now,
        updated_at: now,
      } as any,
    });

    // 2. Draft version.
    const version = await this.prisma.automation_versions.create({
      data: {
        automation_id: automation.id,
        number: 1,
        status: 'draft',
        publisher_id: userId,
        created_at: now,
      } as any,
    });
    await this.prisma.automations.update({
      where: { id: automation.id },
      data: { draft_version_id: version.id },
    });

    // 3. Slug remap tables — foreign slugs come from the export, fresh ones
    //    get generated locally. Connections in step 4 use these maps to
    //    resolve the new step/activity ids.
    const stepIdBySlug = new Map<string, bigint>();
    const stepSlugRemap = new Map<string, string>(); // old → new slug
    const activityIdBySlug = new Map<string, bigint>();
    const activitySlugRemap = new Map<string, string>();
    const qrIdBySlug = new Map<string, bigint>();
    const qrSlugRemap = new Map<string, string>();

    // 4. Recreate steps + their activities + quick replies.
    const stepsIn = Array.isArray(payload.steps) ? payload.steps : [];
    for (const s of stepsIn) {
      const oldSlug = String(s.slug ?? '');
      const newSlug = this.generateSlug();
      if (oldSlug) stepSlugRemap.set(oldSlug, newSlug);

      const step = await this.prisma.automation_steps.create({
        data: {
          automation_version_id: version.id,
          slug: newSlug,
          title: String(s.title ?? 'Step'),
          type: String(s.type ?? 'action'),
          properties: typeof s.properties === 'string' ? s.properties : JSON.stringify(s.properties ?? {}),
          cloneable: s.cloneable !== false,
          deletable: s.deletable !== false,
          linkable: s.linkable !== false,
        } as any,
      });
      if (oldSlug) stepIdBySlug.set(oldSlug, step.id);
      stepIdBySlug.set(newSlug, step.id);

      // Activities under this step.
      const acts = Array.isArray(s.activities) ? s.activities : [];
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        const oldA = String(a.slug ?? '');
        const newA = this.generateSlug();
        if (oldA) activitySlugRemap.set(oldA, newA);

        const activity = await this.prisma.automation_step_activities.create({
          data: {
            slug: newA,
            step_id: step.id,
            parent_id: null,
            event: a.event ?? null,
            properties: typeof a.properties === 'string' ? a.properties : JSON.stringify(a.properties ?? {}),
            linkable: a.linkable !== false,
            order: Number(a.order ?? i + 1),
          } as any,
        });
        if (oldA) activityIdBySlug.set(oldA, activity.id);
        activityIdBySlug.set(newA, activity.id);
      }

      // Quick replies under this step.
      const qrs = Array.isArray(s.quick_replies) ? s.quick_replies : [];
      for (let i = 0; i < qrs.length; i++) {
        const q = qrs[i];
        const oldQ = String(q.slug ?? '');
        const newQ = this.generateSlug();
        if (oldQ) qrSlugRemap.set(oldQ, newQ);

        const row = await this.prisma.automation_quick_replies.create({
          data: {
            automation_step_id: step.id,
            slug: newQ,
            title: String(q.title ?? 'Reply'),
            order: Number(q.order ?? i + 1),
          } as any,
        });
        if (oldQ) qrIdBySlug.set(oldQ, row.id);
        qrIdBySlug.set(newQ, row.id);
      }
    }

    // 5. Connections — convert the export's slug-based references into the
    //    fresh ids we just created.
    const connectionsIn = Array.isArray(payload.connections) ? payload.connections : [];
    for (const c of connectionsIn) {
      const connectorType = String(c.connector_type ?? '');
      const oldConnSlug = String(c.connector_slug ?? '');
      const oldNextStepSlug = String(c.next_step_slug ?? '');

      const nextStepId = stepIdBySlug.get(oldNextStepSlug);
      if (!nextStepId) continue; // ignore broken refs

      let connectorId: bigint | null = null;
      if (connectorType.includes('AutomationStep') && !connectorType.includes('Activity')) {
        connectorId = stepIdBySlug.get(oldConnSlug) ?? null;
      } else if (connectorType.includes('AutomationStepActivity')) {
        connectorId = activityIdBySlug.get(oldConnSlug) ?? null;
      } else if (connectorType.includes('AutomationQuickReply')) {
        connectorId = qrIdBySlug.get(oldConnSlug) ?? null;
      }
      if (!connectorId) continue;

      await this.prisma.automation_flow.create({
        data: {
          automation_version_id: version.id,
          slug: this.generateSlug(),
          next_step_id: nextStepId,
          connector_id: connectorId,
          connector_type: connectorType,
          deleteable: c.deleteable !== false,
        } as any,
      });
    }

    return {
      success: true,
      automation_id: automation.id.toString(),
      version_id: version.id.toString(),
      steps_imported: stepsIn.length,
      connections_imported: connectionsIn.length,
    };
  }

  /**
   * Canvas stats snapshot — returns per-step + per-activity counts the
   * frontend overlay renders as badges next to each node.
   *
   * Reads automation_step_statistics, automation_activity_statistics,
   * automation_activity_clicks, automation_quick_reply_clicks, and the
   * top-level total_runs / total_clicks on the automation row.
   */
  async getStats(workspaceId: bigint, automationId: bigint) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new NotFoundException('Automation not found');
    const versionId = automation.draft_version_id ?? automation.published_version_id;
    if (!versionId) {
      return { total_runs: 0, total_clicks: 0, steps: {}, activities: {} };
    }

    const steps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: versionId, deleted_at: null },
      select: { id: true, slug: true, comment: true },
    });
    const activities = await this.prisma.automation_step_activities.findMany({
      where: { step_id: { in: steps.map((s) => s.id) }, deleted_at: null },
      select: { id: true, slug: true, step_id: true },
    });
    const stepStatRows = await this.prisma.automation_step_statistics.findMany({
      where: { step_slug: { in: steps.map((s) => s.slug).filter(Boolean) as string[] } },
    });
    const activityStatRows = await this.prisma.automation_activity_statistics.findMany({
      where: { activity_slug: { in: activities.map((a) => a.slug).filter(Boolean) as string[] } },
    });
    const clickRows = await this.prisma.automation_activity_clicks.aggregate({
      where: { automation_id: automationId },
      _sum: { clicks: true },
    });

    // Index by FE node id (= step.comment) so the UI badge can lookup with
    // the same key it uses on the canvas.
    const stepsByNodeId: Record<string, any> = {};
    for (const s of steps) {
      if (!s.comment) continue;
      const stats = stepStatRows.find((r) => r.step_slug === s.slug);
      stepsByNodeId[s.comment] = this.parseJSON(stats?.stats) ?? { runs: 0 };
    }
    const activitiesByStepNode: Record<string, any> = {};
    for (const s of steps) {
      if (!s.comment) continue;
      const childActs = activities.filter((a) => a.step_id === s.id);
      activitiesByStepNode[s.comment] = childActs.map((a) => {
        const stats = activityStatRows.find((r) => r.activity_slug === a.slug);
        return {
          activity_id: a.id.toString(),
          slug: a.slug,
          stats: this.parseJSON(stats?.stats) ?? { runs: 0 },
        };
      });
    }

    return {
      total_runs: Number(automation.total_runs ?? 0),
      total_clicks: Number(automation.total_clicks ?? 0),
      total_unique_clicks: Number(clickRows._sum.clicks ?? 0),
      steps: stepsByNodeId,
      activities: activitiesByStepNode,
    };
  }

  /**
   * Step-level trigger — find the first activity on this step and fire it
   * against the given contact. Used by pipelines/reports/inbox flows.
   */
  async stepTriggerAutomation(stepId: bigint, contactId: bigint) {
    const activity = await this.prisma.automation_step_activities.findFirst({
      where: { step_id: stepId, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    if (!activity) {
      return { triggered: false, reason: 'no_activity_on_step' };
    }
    // Inline import to avoid circular dep; AutomationsService is consumed by
    // controllers that already inject the processor separately, but the
    // step-trigger callers expect a single round trip — we call the same
    // dispatch path the controller uses.
    // (Note: this method is invoked through the controller which has the
    // processor injected; if we ever invoke directly from non-controller
    // code we'll need to inject the processor here too.)
    return {
      triggered: true,
      activity_id: activity.id.toString(),
      contact_id: contactId.toString(),
      // The controller will call processor.triggerAutomation(activity.id, contactId);
      // we return the resolved activity id so the controller's wrapper can
      // dispatch without re-querying.
    };
  }

  /**
   * Export every automation attached to a bundle, plus the bundle metadata,
   * as a JSON tree. The shape mirrors `importAutomation`'s expected payload
   * so a round-trip import recreates the steps faithfully.
   */
  async exportCloneKit(workspaceId: bigint, bundleId: bigint) {
    const bundle = await this.prisma.bundles.findFirst({
      where: { id: bundleId, workspace_id: Number(workspaceId) },
    });
    if (!bundle) throw new NotFoundException('Bundle not found');

    // Mirror replyagent: bundles reference automations via bundle_id on the
    // automations row. Pull every active row.
    const automations = await this.prisma.automations.findMany({
      where: { bundle_id: bundleId, deleted_at: null },
    });

    const exported: any[] = [];
    for (const a of automations) {
      const versionId = a.published_version_id ?? a.draft_version_id;
      if (!versionId) continue;

      const steps = await this.prisma.automation_steps.findMany({
        where: { automation_version_id: versionId, deleted_at: null },
        orderBy: { id: 'asc' },
      });
      const stepsOut: any[] = [];
      for (const s of steps) {
        const activities = await this.prisma.automation_step_activities.findMany({
          where: { step_id: s.id, deleted_at: null },
          orderBy: { order: 'asc' },
        });
        const quickReplies = await this.prisma.automation_quick_replies.findMany({
          where: { automation_step_id: s.id, deleted_at: null },
        });
        stepsOut.push({
          slug: s.slug,
          title: s.title,
          type: s.type,
          properties: this.parseJSON(s.properties),
          cloneable: s.cloneable,
          deletable: s.deletable,
          linkable: s.linkable,
          activities: activities.map((act) => ({
            slug: act.slug,
            event: act.event,
            properties: this.parseJSON(act.properties),
            linkable: act.linkable,
            order: act.order,
          })),
          quick_replies: quickReplies.map((q) => ({
            slug: q.slug,
            title: q.title,
            order: q.order,
          })),
        });
      }

      const connections = await this.prisma.automation_flow.findMany({
        where: { automation_version_id: versionId, deleted_at: null },
      });
      // Resolve connector_id → connector_slug and next_step_id → next_step_slug
      // for portability across the import boundary.
      const connectionsOut: any[] = [];
      for (const c of connections) {
        const nextStep = steps.find((s) => s.id === c.next_step_id);
        let connectorSlug: string | null = null;
        if (c.connector_type.includes('AutomationStep') && !c.connector_type.includes('Activity')) {
          const s = steps.find((s) => s.id === c.connector_id);
          connectorSlug = s?.slug ?? null;
        }
        if (!nextStep || !connectorSlug) continue;
        connectionsOut.push({
          slug: c.slug,
          connector_slug: connectorSlug,
          connector_type: c.connector_type,
          next_step_slug: nextStep.slug,
        });
      }

      exported.push({
        name: a.name,
        template: a.template ?? null,
        steps: stepsOut,
        connections: connectionsOut,
      });
    }

    return {
      bundle: {
        id: bundle.id.toString(),
        slug: bundle.slug,
        name: bundle.name,
        description: bundle.description,
      },
      automations: exported,
    };
  }

  /**
   * Share a clone-kit export to a recipient workspace by importing each
   * automation into that workspace. Returns the ids of the newly-created
   * automations so the caller can deep-link the recipient.
   */
  async shareCloneKit(
    sourceWorkspaceId: bigint,
    userId: bigint,
    bundleId: bigint,
    recipientWorkspaceId: bigint | null,
  ) {
    const exported = await this.exportCloneKit(sourceWorkspaceId, bundleId);
    if (!recipientWorkspaceId) {
      // No recipient — just return the export so the caller can hand the
      // JSON off (replyagent's flow generates a shareable link in this case).
      return { share_payload: exported };
    }
    const imported: string[] = [];
    for (const a of exported.automations) {
      const result = await this.importAutomation(recipientWorkspaceId, userId, a);
      imported.push(result.automation_id);
    }
    return {
      shared_to_workspace_id: recipientWorkspaceId.toString(),
      automations_imported: imported,
    };
  }

  /** Defensive JSON parser used by export helpers. */
  private parseJSON(raw: any): any {
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Reconcile a React-Flow graph into the canonical step/activity/flow rows.
   *
   * Strategy: keep a `node.id → step.id` map across saves by stamping the
   * frontend's node id into `step.comment` (cheap "tag" column) so the
   * second-save edit case doesn't recreate everything. Edges become rows in
   * `automation_flow`.
   *
   * On every call:
   *   1. Build a set of node-ids still present.
   *   2. Existing steps NOT in the set get soft-deleted (deleted_at = now).
   *   3. For each node: upsert step + first activity with the resolved type/slug.
   *   4. Wipe existing automation_flow rows for this version and recreate from edges.
   */
  async syncGraph(
    workspaceId: bigint,
    automationId: bigint,
    nodes: any[],
    edges: any[],
  ) {
    const automation = await this.prisma.automations.findFirst({
      where: { id: automationId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) throw new NotFoundException('Automation not found');
    const versionId = automation.draft_version_id;
    if (!versionId) throw new BadRequestException('Automation has no draft version');

    const now = new Date();
    const nodeIds = new Set(nodes.map((n: any) => String(n.id)));

    // Load existing steps for this version.
    const existingSteps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: versionId, deleted_at: null },
    });

    // Map node.id → step.id via step.comment (we stash the FE id there).
    const stepByNodeId = new Map<string, any>();
    for (const s of existingSteps) {
      if (s.comment && nodeIds.has(s.comment)) {
        stepByNodeId.set(s.comment, s);
      }
    }

    // 2. Soft-delete steps whose node is gone.
    const orphanIds = existingSteps
      .filter((s) => !s.comment || !nodeIds.has(s.comment))
      .map((s) => s.id);
    if (orphanIds.length > 0) {
      await this.prisma.automation_steps.updateMany({
        where: { id: { in: orphanIds } },
        data: { deleted_at: now },
      });
      // Also soft-delete their activities.
      await this.prisma.automation_step_activities.updateMany({
        where: { step_id: { in: orphanIds } },
        data: { deleted_at: now },
      });
    }

    // 3. Upsert each node.
    for (const node of nodes) {
      const nId = String(node.id);
      const data = node.data ?? {};
      const stepType = String(data.stepType ?? 'action');
      const actionSlug = data.actionSlug ?? null;
      const title = String(data.label ?? 'Step');
      const properties = JSON.stringify({
        x: node.position?.x ?? 0,
        y: node.position?.y ?? 0,
        ...((data.properties ?? {}) as object),
      });
      const activityProps = JSON.stringify({
        slug: actionSlug,
        ...((data.activity_properties ?? data.value ?? {}) as object),
      });

      const existing = stepByNodeId.get(nId);
      let stepRow: any;
      if (existing) {
        stepRow = await this.prisma.automation_steps.update({
          where: { id: existing.id },
          data: {
            title,
            type: stepType,
            properties,
            updated_at: now,
            comment: nId,
          } as any,
        });
      } else {
        stepRow = await this.prisma.automation_steps.create({
          data: {
            automation_version_id: versionId,
            slug: this.generateSlug(),
            title,
            type: stepType,
            properties,
            cloneable: true,
            deletable: true,
            linkable: true,
            comment: nId,
          } as any,
        });
      }

      // Ensure the first activity exists and carries the action slug.
      const firstActivity = await this.prisma.automation_step_activities.findFirst({
        where: { step_id: stepRow.id, deleted_at: null },
        orderBy: { order: 'asc' },
      });
      if (firstActivity) {
        await this.prisma.automation_step_activities.update({
          where: { id: firstActivity.id },
          data: {
            event: data.triggerEvent ?? firstActivity.event,
            properties: activityProps,
            updated_at: now,
          } as any,
        });
      } else {
        await this.prisma.automation_step_activities.create({
          data: {
            slug: this.generateSlug(),
            step_id: stepRow.id,
            parent_id: null,
            event: data.triggerEvent ?? null,
            properties: activityProps,
            linkable: true,
            order: 1,
          } as any,
        });
      }

      // Cache the step for the connection pass.
      stepByNodeId.set(nId, stepRow);
    }

    // 4. Reset flow connections for this version.
    //
    // Defensive guard against the "hydrate race + wipe" bug: if the
    // client sent an empty edges array but there are >= 2 nodes and
    // the version already has persisted flows, this is almost
    // certainly a stale-state save (initial state.edges=[] leaking
    // into an auto-save before the user actually deleted anything).
    // Preserve the existing flows in that case — the manual Save
    // button still allows an explicit clear via a subsequent call
    // that sends non-empty edges. This is what stops the recurring
    // "flow saved once but strings gone on reopen" bug: the auto-
    // save fired after a node-drag before the flow rows were even
    // hydrated into state.edges.
    let edgesSyncedCount = edges.length;
    let flowsPreserved = false;
    if (edges.length === 0 && nodes.length >= 2) {
      const existingFlowCount = await this.prisma.automation_flow.count({
        where: { automation_version_id: versionId, deleted_at: null },
      });
      if (existingFlowCount > 0) {
        flowsPreserved = true;
        edgesSyncedCount = existingFlowCount;
        this.logger.warn(
          `syncGraph: preserved ${existingFlowCount} existing flow(s) for automation ${automationId} — payload had empty edges with ${nodes.length} nodes (suspicious wipe)`,
        );
      }
    }
    if (!flowsPreserved) {
      await this.prisma.automation_flow.deleteMany({
        where: { automation_version_id: versionId },
      });
      for (const edge of edges) {
        const sourceNode = String(edge.source ?? '');
        const targetNode = String(edge.target ?? '');
        const sourceStep = stepByNodeId.get(sourceNode);
        const targetStep = stepByNodeId.get(targetNode);
        if (!sourceStep || !targetStep) continue;

        // Encode React Flow's sourceHandle (branch id on multi-output
        // nodes like Randomizer / Splitter / Condition) into the slug
        // field. The automation_flow table has no dedicated column
        // for it and Cloud Run doesn't auto-run migrations, so we
        // prefix the slug as `sh:<handle>:<random>` when a handle is
        // present. getAutomation parses it back out. Without this,
        // Randomizer A/B branches lose their handle on reopen and
        // React Flow refuses to render the edge ("Couldn't create
        // edge for source handle id: undefined").
        const rawHandle = edge.sourceHandle;
        // Treat literal 'undefined' / 'null' string values as absent —
        // React Flow's older versions coerced Handle id={undefined} to
        // the string "undefined", which could round-trip through
        // sync-graph payloads before the FE-side fix landed. Persisting
        // that string would break the edge on the next reopen.
        const handleStr =
          rawHandle == null ||
          rawHandle === '' ||
          rawHandle === 'undefined' ||
          rawHandle === 'null'
            ? null
            : String(rawHandle).replace(/:/g, '_');
        const baseSlug = this.generateSlug();
        const slug = handleStr ? `sh:${handleStr}:${baseSlug}` : baseSlug;

        await this.prisma.automation_flow.create({
          data: {
            automation_version_id: versionId,
            slug,
            next_step_id: targetStep.id,
            connector_id: sourceStep.id,
            connector_type: 'App\\Models\\Automations\\AutomationStep',
            deleteable: true,
          } as any,
        });
      }
    }

    return {
      success: true,
      nodes_synced: nodes.length,
      edges_synced: edgesSyncedCount,
      orphans_removed: orphanIds.length,
      flows_preserved: flowsPreserved,
    };
  }

  /**
   * Resolve the contact behind an inbox row. Used by the manual-trigger
   * endpoint when the agent fires an automation from a conversation.
   * The inbox row stores `modelable_type/id` polymorphically — we follow
   * the channel-specific chat table to find the contact_id.
   */
  async lookupInboxContact(inboxId: bigint, workspaceId: bigint): Promise<bigint | null> {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) return null;

    const mType = inbox.modelable_type ?? '';
    const mId = inbox.modelable_id;
    if (!mId) return null;

    try {
      if (mType.includes('WhatsappChat')) {
        const chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('TelegramChat')) {
        const chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('FacebookChat')) {
        const chat = await this.prisma.fb_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('InstagramChat') || mType.includes('InstaChat')) {
        const chat = await this.prisma.insta_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('WebchatChat') || mType.includes('WcChat')) {
        const chat = await this.prisma.wc_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('App\\Models\\Contact')) {
        return mId;
      }
    } catch (e: any) {
      this.logger.warn(`lookupInboxContact failed for inbox ${inboxId}: ${e?.message ?? e}`);
    }
    return null;
  }
}
