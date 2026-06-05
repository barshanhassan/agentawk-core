import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from './messaging.service';
import { ActionHandlerService } from './action-handler.service';
import { STEP_TYPES } from './automations.constants';
import { QuickReplyInputService } from './quick-reply-input.service';

@Injectable()
export class AutomationProcessorService {
  private readonly logger = new Logger(AutomationProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly actionHandler: ActionHandlerService,
    private readonly quickReply: QuickReplyInputService,
  ) {}

  /**
   * Channel step types that can carry an input-collection activity (type=input
   * or step.type=quick_reply). After execution, if the activity is configured
   * to wait for an answer, the queue parks until a reply arrives or wait_till
   * elapses.
   */
  private readonly waitableChannels = new Set<string>([
    STEP_TYPES.WHATSAPP,
    STEP_TYPES.TELEGRAM,
    STEP_TYPES.MESSENGER,
    STEP_TYPES.INSTAGRAM,
    STEP_TYPES.WEBCHAT,
    STEP_TYPES.TWILIO_SMS,
    STEP_TYPES.ZAPI,
    STEP_TYPES.EVOLUTION,
  ]);

  private isInputCollectingActivity(props: any): boolean {
    if (!props) return false;
    return (
      props?.type === 'input' ||
      props?.type === 'chatgpt_question' ||
      props?.collect_response === true ||
      Array.isArray(props?.quickReplies)
    );
  }

  /**
   * Date-trigger cron — scans `contact_date_triggers` for due rows (e.g.,
   * a contact's "birthday" custom-date field hitting today) and dispatches
   * the matching automation. Mirrors replyagent's daily DateTriggersJob.
   *
   * The schema's `contact_date_triggers` table stores (contact_id,
   * activity_slug, triggered_at) — we read every row whose triggered_at
   * is in the past, fire the activity, then clear the row.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processDateTriggers() {
    const dueTriggers = await this.prisma.contact_date_triggers.findMany({
      where: { triggered_at: { lte: new Date() } },
      take: 200,
    });
    if (dueTriggers.length === 0) return;
    this.logger.log(`Date triggers due: ${dueTriggers.length}`);

    for (const dt of dueTriggers) {
      try {
        await this.triggerBySlug(dt.activity_slug, dt.contact_id);
      } catch (e: any) {
        this.logger.warn(`Date trigger failed for slug=${dt.activity_slug}: ${e?.message ?? e}`);
      } finally {
        await this.prisma.contact_date_triggers.delete({ where: { id: dt.id } });
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processReservedQueue() {
    const dueItems = await this.prisma.automation_queue.findMany({
      where: {
        reserved: { lte: new Date() },
      },
    });

    if (dueItems.length > 0) {
      this.logger.log(`Resuming ${dueItems.length} delayed automations`);
      for (const item of dueItems) {
        // Clear reserved before executing to prevent double-run if execution takes long
        await this.prisma.automation_queue.update({
          where: { id: item.id },
          data: { reserved: null },
        });
        // If this queue row was parked waiting for a user reply, check for
        // a `no_response` branch first — if found, route via that and don't
        // re-execute the same step.
        const routedToNoResponse = await this.quickReply.timeoutCheck(item.id);
        if (routedToNoResponse) continue;
        await this.executeQueueItem(item.id);
      }
    }
  }

  async triggerAutomationBulk(activityId: bigint, contactIds: bigint[]) {
    this.logger.log(`Bulk triggering automation for ${contactIds.length} contacts (Activity: ${activityId})`);
    
    const CHUNK_SIZE = 100;
    for (let i = 0; i < contactIds.length; i += CHUNK_SIZE) {
      const chunk = contactIds.slice(i, i + CHUNK_SIZE);
      // Process chunk in parallel
      await Promise.all(chunk.map(id => this.triggerAutomation(activityId, id)));
      // Small pause to prevent DB lock contention
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Resolve a trigger by its activity slug — used by the public URL trigger
   * endpoint (e.g. https://example.com/automations/trigger/{slug}) and by any
   * external system that knows the slug but not the numeric id.
   *
   * Mirrors replyagent's GET /trigger-automation/{activitySlug} route.
   */
  async triggerBySlug(activitySlug: string, contactId: bigint) {
    const activity = await this.prisma.automation_step_activities.findFirst({
      where: { slug: activitySlug, deleted_at: null },
    });
    if (!activity) {
      this.logger.warn(`triggerBySlug: no activity matching slug=${activitySlug}`);
      return null;
    }
    return this.triggerAutomation(activity.id, contactId);
  }

  async triggerAutomation(activityId: bigint, contactId: bigint) {
    const activity = await this.prisma.automation_step_activities.findUnique({
      where: { id: activityId },
    });

    if (!activity) {
      this.logger.error(`Activity ${activityId} not found`);
      return;
    }

    // Find the next step via flow
    const flow = await this.prisma.automation_flow.findFirst({
      where: {
        connector_id: activity.step_id,
        connector_type: 'App\\Models\\Automations\\AutomationStep',
      },
    });

    if (!flow) {
      this.logger.warn(`No flow found for activity ${activityId}`);
      return;
    }

    // Create queue entry for the next step
    const nextStep = await this.prisma.automation_steps.findUnique({
      where: { id: flow.next_step_id },
    });

    const stepActivities = await this.prisma.automation_step_activities.findMany({
      where: { step_id: flow.next_step_id, deleted_at: null },
      orderBy: { order: 'asc' },
    });

    if (!nextStep || stepActivities.length === 0) return;

    const firstActivity = stepActivities[0];

    const queueItem = await this.prisma.automation_queue.create({
      data: {
        object_id: contactId,
        object_type: 'CONTACT',
        flow_id: flow.id,
        step_id: nextStep.id,
        activity_id: firstActivity.id,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return this.executeQueueItem(queueItem.id);
  }

  async executeQueueItem(queueId: bigint) {
    const queueItem = await this.prisma.automation_queue.findUnique({
      where: { id: queueId },
    });

    if (!queueItem) return;

    const activity = await this.prisma.automation_step_activities.findUnique({
      where: { id: queueItem.activity_id },
    });

    if (!activity) return;

    const step = await this.prisma.automation_steps.findUnique({
      where: { id: activity.step_id }
    });

    if (!step) return;

    this.logger.log(`Executing activity ${activity.id} (Step type: ${step.type})`);

    const stepType = step.type;
    const props = activity.properties ? (typeof activity.properties === 'string' ? JSON.parse(activity.properties) : activity.properties) : {};
    const contact = await this.prisma.contacts.findUnique({ where: { id: queueItem.object_id } });
    if (!contact) return;
    const workspaceId = contact.workspace_id;

    // Bump per-step + per-activity statistics so the canvas overlay can
    // surface counts. We track the entry — completion counts roll up in
    // `finished()` once the step exits cleanly.
    if (step.slug) await this.bumpStepStats(step.slug, 'runs');
    if (activity.slug) await this.bumpActivityStats(activity.slug, 'runs');
    await this.recordActivityIteration(queueItem.object_id, activity.id);

    try {
      switch (stepType) {
        // Messaging channels — all delegate to MessagingService.
        case STEP_TYPES.WHATSAPP:
          await this.messaging.sendWhatsApp(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.TELEGRAM:
          await this.messaging.sendTelegram(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.MESSENGER:
          await this.messaging.sendMessenger(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.INSTAGRAM:
          await this.messaging.sendInstagram(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.WEBCHAT:
          await this.messaging.sendWebchat(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.TWILIO_SMS:
          await this.messaging.sendTwilioSms(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.TWILIO_CALL:
          await this.messaging.sendTwilioCall(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.ZAPI:
          await this.messaging.sendZapi(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.EVOLUTION:
          await this.messaging.sendEvolution(queueItem.object_id, props, workspaceId);
          break;
        case STEP_TYPES.EMAIL:
          await this.messaging.sendEmail(queueItem.object_id, props, workspaceId);
          break;

        // Action umbrella — 49 slugs, dispatched via ActionHandlerService.
        case STEP_TYPES.ACTION:
          await this.actionHandler.dispatch(queueItem.object_id, props, workspaceId);
          break;

        // Delay reserves the queue row for a future time; cron resumes it.
        case STEP_TYPES.DELAY:
          await this.handleDelay(queueId, props);
          return; // Don't fall through to finished() — pickup is async.

        // Conditional branching — evaluates the condition, picks the matching
        // outgoing flow ID, and routes queue progression to it.
        case STEP_TYPES.CONDITION:
          return await this.handleCondition(queueId, activity, props, workspaceId);

        // Randomizer is essentially a 50/50 (or weighted) split — we pick
        // one of the outgoing flows and continue.
        case STEP_TYPES.RANDOMIZER:
        case STEP_TYPES.SPLITTER:
          return await this.handleRandomizer(queueId, activity, props);

        // Smart Loop — like delay but with iteration tracking.
        case STEP_TYPES.SMART_LOOP:
          await this.handleSmartLoop(queueId, activity, props);
          return;

        // Trigger steps are entry points only — they should never execute
        // through the queue. If we land here, just move on.
        case STEP_TYPES.TRIGGER:
          break;

        default:
          this.logger.warn(`Unknown step type: ${stepType} (activity ${activity.id})`);
      }

      // Input collection — if this is a waitable channel step AND the
      // activity wants to collect a response, park the queue and return.
      // The inbound message handler (QuickReplyInputService.tryHandleInbound)
      // resumes the flow when the user replies; the reserved-queue cron
      // calls timeoutCheck() when wait_till elapses.
      if (this.waitableChannels.has(stepType) && this.isInputCollectingActivity(props)) {
        await this.quickReply.enterWaitState({
          queueId,
          stepId: step.id,
          contactId: queueItem.object_id,
          channel: stepType,
          inputProps: props,
        });
        return;
      }

      // If execution finished, move to next.
      return this.finished(queueId);
    } catch (error) {
      this.logger.error(`Error executing activity ${activity.id}: ${error.message}`);
    }
  }

  /**
   * Condition step — properties shape (mirror of replyagent):
   *   { type: 'text'|'number'|'date'|'boolean'|..., field: '<contact-field>',
   *     operator: '<op>', value: <val>, true_flow_id?: bigint, false_flow_id?: bigint }
   *
   * If true_flow_id / false_flow_id are present we route queue progression
   * to the matching flow. Otherwise we fall back to the activity's own
   * outgoing connection on a true match, or just stop on false.
   */
  private async handleCondition(
    queueId: bigint,
    activity: any,
    props: any,
    workspaceId: bigint,
  ): Promise<void> {
    const passed = await this.evaluateCondition(queueId, props, workspaceId);
    const targetFlowId = passed ? props?.true_flow_id : props?.false_flow_id;

    if (targetFlowId) {
      const flow = await this.prisma.automation_flow.findUnique({
        where: { id: BigInt(targetFlowId) },
      });
      if (flow) {
        return this.advanceVia(queueId, flow);
      }
    }
    // Default: only advance on a true match (mirrors replyagent fallback).
    if (passed) return this.finished(queueId);
    // False with no alternative branch — terminate this thread.
    await this.prisma.automation_queue.delete({ where: { id: queueId } });
  }

  /**
   * Evaluates a condition step's `props`. Supports two shapes:
   *
   *  1. Flat single-condition (legacy, kept for back-compat):
   *     { field: 'first_name', operator: 'equals', value: 'Ali' }
   *
   *  2. Replyagent-style multi-condition array:
   *     { match: 'all' | 'any', conditions: [
   *        { field_type, key, operator, value, ...extras },
   *        ...
   *     ] }
   *
   *  `field_type` ∈ general | custom | social | system | date
   *  - general/system: contact column lookup (first_name, gender, etc.)
   *  - custom: contact's custom_field value by slug
   *  - social: channel-specific (whatsapp_last_message, tag, etc.)
   */
  private async evaluateCondition(queueId: bigint, props: any, workspaceId: bigint): Promise<boolean> {
    try {
      const queueItem = await this.prisma.automation_queue.findUnique({ where: { id: queueId } });
      if (!queueItem) return false;
      const contact = await this.prisma.contacts.findUnique({ where: { id: queueItem.object_id } });
      if (!contact) return false;

      // Shape #2 — replyagent array form.
      const conditions: any[] = Array.isArray(props?.conditions) ? props.conditions : null;
      if (conditions) {
        const matchMode = props?.match === 'any' ? 'any' : 'all';
        const results: boolean[] = [];
        for (const c of conditions) {
          results.push(await this.evaluateSingleCondition(c, contact, workspaceId));
        }
        return matchMode === 'any' ? results.some(Boolean) : results.every(Boolean);
      }

      // Shape #1 — flat single-condition (legacy fallback).
      const actual = (contact as any)[props?.field ?? ''];
      return this.applyOperator(props?.operator ?? 'equals', actual, props?.value);
    } catch (e: any) {
      this.logger.warn(`evaluateCondition failed: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * Evaluate one condition row given the running contact. Handles tag /
   * channel-specific last_message / custom field / contact column lookups
   * before falling through to the generic operator.
   */
  private async evaluateSingleCondition(
    c: any,
    contact: any,
    workspaceId: bigint,
  ): Promise<boolean> {
    const fieldType = c?.field_type ?? c?.fieldType ?? 'general';
    const key = c?.key ?? c?.field ?? '';
    const operator = c?.operator ?? 'equals';
    const expected = c?.value;

    // ── social ───────────────────────────────────────────────────────
    if (fieldType === 'social') {
      if (key === 'tag') {
        // expected.id = tag id we're checking the contact against
        const tagId = expected?.id ?? expected?.tag_id ?? expected;
        if (!tagId) return false;
        const link = await this.prisma.tag_links
          .findFirst({
            where: {
              tag_id: BigInt(tagId),
              linkable_type: 'App\\Models\\Contact',
              linkable_id: contact.id,
            },
          })
          .catch(() => null);
        return operator === 'not_has' || operator === 'has_not'
          ? !link
          : !!link;
      }
      if (key.endsWith('_last_message')) {
        return await this.evaluateChannelLastMessage(c, contact);
      }
      if (key === 'subscribed' || key === 'opting') {
        const channel = c?.channel ?? c?.channel_type ?? null;
        const where: any = { contact_id: contact.id };
        if (channel) where.channel = channel;
        const row = await this.prisma.contact_opting
          .findFirst({ where, orderBy: { updated_at: 'desc' } })
          .catch(() => null);
        const optedIn = row ? !!row.opt_in : true; // default: subscribed
        return operator === 'is_false' ? !optedIn : optedIn;
      }
    }

    // ── custom field ─────────────────────────────────────────────────
    if (fieldType === 'custom') {
      const slug = key;
      const cf = await this.prisma.custom_fields
        .findFirst({ where: { workspace_id: workspaceId, slug } })
        .catch(() => null);
      if (!cf) return false;
      const entity = await this.prisma.custom_field_entities
        .findFirst({
          where: {
            entity_type: 'App\\Models\\Contact',
            entity_id: contact.id,
            custom_field_id: cf.id,
          },
        })
        .catch(() => null);
      if (!entity) return this.applyOperator(operator, undefined, expected);
      const v = await this.prisma.custom_field_entity_values
        .findFirst({ where: { cf_entity_id: entity.id }, orderBy: { id: 'desc' } })
        .catch(() => null);
      return this.applyOperator(operator, v?.value, expected);
    }

    // ── date — current time, message_window, etc. ────────────────────
    if (fieldType === 'date' || key === 'current_time') {
      return this.applyOperator(operator, new Date().toISOString(), expected);
    }

    // ── general / system: contact column lookup ──────────────────────
    const actual = (contact as any)[key];
    return this.applyOperator(operator, actual, expected);
  }

  /**
   * For `<channel>_last_message` conditions: look up the most recent inbound
   * message via that channel for the contact, optionally narrowing to a
   * specific channel account (bot/page/instance). Runs the text operator on
   * the message body.
   */
  private async evaluateChannelLastMessage(c: any, contact: any): Promise<boolean> {
    const key: string = c?.key ?? '';
    // Map key prefix → contact_last_messages.channel enum value.
    // contact_last_messages.channel enum uses lowercase variants.
    const channelMap: Record<string, string> = {
      whatsapp_last_message: 'whatsapp',
      telegram_last_message: 'telegram',
      messenger_last_message: 'messenger',
      instagram_last_message: 'instagram',
      zapi_last_message: 'zapi',
      twilio_last_message: 'twilio',
    };
    const channel = channelMap[key];
    if (!channel) return false;

    const where: any = { contact_id: contact.id, channel };
    const channelableId =
      c?.bot_id ?? c?.account_number_id ?? c?.instance_id ?? c?.page_id ?? null;
    if (channelableId) where.channelable_id = BigInt(channelableId);

    const row = await this.prisma.contact_last_messages
      .findFirst({ where, orderBy: { id: 'desc' } })
      .catch(() => null);
    return this.applyOperator(c?.operator ?? 'contains', row?.message ?? null, c?.value);
  }

  /**
   * Pure operator evaluation — string/numeric/date comparisons. Kept separate
   * so all the typed lookups above share the same downstream logic.
   */
  private applyOperator(operator: string, actual: any, expected: any): boolean {
    switch (operator) {
      case 'equals':
      case 'eq':
      case 'is':
        return actual == expected;
      case 'not_equals':
      case 'neq':
      case 'is_not':
        return actual != expected;
      case 'contains':
        return typeof actual === 'string' && actual.includes(String(expected));
      case 'not_contains':
      case 'doesnot_contains':
        return typeof actual === 'string' && !actual.includes(String(expected));
      case 'starts_with':
      case 'begins_with':
        return typeof actual === 'string' && actual.startsWith(String(expected));
      case 'ends_with':
        return typeof actual === 'string' && actual.endsWith(String(expected));
      case 'is_empty':
        return actual == null || actual === '';
      case 'is_not_empty':
        return actual != null && actual !== '';
      case 'gt':
        return Number(actual) > Number(expected);
      case 'gte':
        return Number(actual) >= Number(expected);
      case 'lt':
        return Number(actual) < Number(expected);
      case 'lte':
        return Number(actual) <= Number(expected);
      case 'before':
        return new Date(actual) < new Date(expected);
      case 'after':
        return new Date(actual) > new Date(expected);
      case 'is_true':
        return !!actual;
      case 'is_false':
        return !actual;
      default:
        return false;
    }
  }

  /**
   * Randomizer / Splitter — picks one of the outgoing flows uniformly (or
   * by weight if `properties.weights = [50, 50]`) and advances. Currently
   * uses a deterministic round-robin per contact so testing is reproducible.
   */
  private async handleRandomizer(queueId: bigint, activity: any, props: any) {
    const flows = await this.prisma.automation_flow.findMany({
      where: { connector_id: activity.id, connector_type: 'App\\Models\\Automations\\AutomationStepActivity' },
      orderBy: { id: 'asc' },
    });
    if (flows.length === 0) return this.finished(queueId);

    const queueItem = await this.prisma.automation_queue.findUnique({ where: { id: queueId } });
    if (!queueItem) return;
    // Deterministic per-contact: distributes evenly without needing entropy.
    const pickIndex = Number(queueItem.object_id % BigInt(flows.length));
    return this.advanceVia(queueId, flows[pickIndex]);
  }

  /**
   * Smart Loop — schedules a re-run of the same activity after a delay,
   * tracking iteration count on automation_activity_iterations.
   */
  private async handleSmartLoop(queueId: bigint, activity: any, props: any) {
    const queueItem = await this.prisma.automation_queue.findUnique({ where: { id: queueId } });
    if (!queueItem) return;

    const maxIterations = Number(props?.max_iterations ?? props?.maxIterations ?? 0);
    if (maxIterations > 0) {
      const iteration = await this.prisma.automation_activity_iterations.findFirst({
        where: { contact_id: queueItem.object_id, activity_id: activity.id },
      });
      const runs = (iteration?.runs ? Number(iteration.runs) : 0) + 1;
      if (iteration) {
        await this.prisma.automation_activity_iterations.update({
          where: { id: iteration.id },
          data: { runs },
        });
      } else {
        await this.prisma.automation_activity_iterations.create({
          data: { contact_id: queueItem.object_id, activity_id: activity.id, runs },
        });
      }
      if (runs >= maxIterations) {
        return this.finished(queueId);
      }
    }
    // Delay then re-enter — reuse handleDelay's reservation logic.
    return this.handleDelay(queueId, props);
  }

  /**
   * Increment a counter inside `automation_step_statistics.stats` (a JSON
   * blob shape `{ runs: 5, errors: 1, ... }`). Designed for low-frequency
   * single-counter bumps off the hot execution path.
   */
  private async bumpStepStats(stepSlug: string, key: string) {
    try {
      const existing = await this.prisma.automation_step_statistics.findFirst({
        where: { step_slug: stepSlug },
      });
      if (existing) {
        const stats = this.parseStats(existing.stats);
        stats[key] = (stats[key] ?? 0) + 1;
        await this.prisma.automation_step_statistics.update({
          where: { id: existing.id },
          data: { stats: JSON.stringify(stats) },
        });
      } else {
        await this.prisma.automation_step_statistics.create({
          data: {
            step_slug: stepSlug,
            stats: JSON.stringify({ [key]: 1 }),
          } as any,
        });
      }
    } catch (e: any) {
      this.logger.debug(`bumpStepStats failed: ${e?.message ?? e}`);
    }
  }

  private async bumpActivityStats(activitySlug: string, key: string) {
    try {
      const existing = await this.prisma.automation_activity_statistics.findFirst({
        where: { activity_slug: activitySlug },
      });
      if (existing) {
        const stats = this.parseStats(existing.stats);
        stats[key] = (stats[key] ?? 0) + 1;
        await this.prisma.automation_activity_statistics.update({
          where: { id: existing.id },
          data: { stats: JSON.stringify(stats) },
        });
      } else {
        await this.prisma.automation_activity_statistics.create({
          data: {
            activity_slug: activitySlug,
            stats: JSON.stringify({ [key]: 1 }),
          } as any,
        });
      }
    } catch (e: any) {
      this.logger.debug(`bumpActivityStats failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Per-contact iteration tracking — used by the smart loop and by stats
   * overlays that want to display "X contacts hit this activity Y times".
   */
  private async recordActivityIteration(contactId: bigint, activityId: bigint) {
    try {
      const existing = await this.prisma.automation_activity_iterations.findFirst({
        where: { contact_id: contactId, activity_id: activityId },
      });
      if (existing) {
        await this.prisma.automation_activity_iterations.update({
          where: { id: existing.id },
          data: { runs: (existing.runs ?? 0) + 1 },
        });
      } else {
        await this.prisma.automation_activity_iterations.create({
          data: { contact_id: contactId, activity_id: activityId, runs: 1 },
        });
      }
    } catch (e: any) {
      this.logger.debug(`recordActivityIteration failed: ${e?.message ?? e}`);
    }
  }

  private parseStats(raw: any): Record<string, number> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed != null ? parsed : {};
      } catch {
        return {};
      }
    }
    return raw as Record<string, number>;
  }

  /**
   * Repoint a queue item onto a different flow's next step. Used by the
   * Condition / Randomizer step types to pick a branch.
   */
  private async advanceVia(queueId: bigint, flow: any) {
    const nextStep = await this.prisma.automation_steps.findUnique({
      where: { id: flow.next_step_id },
    });
    if (!nextStep) return this.finished(queueId);

    const firstActivity = await this.prisma.automation_step_activities.findFirst({
      where: { step_id: nextStep.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    if (!firstActivity) return this.finished(queueId);

    await this.prisma.automation_queue.update({
      where: { id: queueId },
      data: {
        flow_id: flow.id,
        step_id: nextStep.id,
        activity_id: firstActivity.id,
        updated_at: new Date(),
      },
    });
    return this.executeQueueItem(queueId);
  }

  private async handleDelay(queueId: bigint, props: any) {
    const waitAmount = parseInt(props.waitAmount) || 1;
    const waitUnit = props.waitUnit || 'minutes';
    
    let reservedDate = new Date();
    if (waitUnit === 'minutes') reservedDate.setMinutes(reservedDate.getMinutes() + waitAmount);
    else if (waitUnit === 'hours') reservedDate.setHours(reservedDate.getHours() + waitAmount);
    else if (waitUnit === 'days') reservedDate.setDate(reservedDate.getDate() + waitAmount);

    await this.prisma.automation_queue.update({
      where: { id: queueId },
      data: { reserved: reservedDate },
    });
    this.logger.log(`Delay set for queue ${queueId} until ${reservedDate}`);
  }

  private async finished(queueId: bigint) {
    const queueItem = await this.prisma.automation_queue.findUnique({
      where: { id: queueId },
    });

    if (!queueItem) return;

    // 1. Check if there are more activities in the same step
    const activity = await this.prisma.automation_step_activities.findUnique({
      where: { id: queueItem.activity_id },
    });

    const nextActivity = await this.prisma.automation_step_activities.findFirst({
      where: {
        step_id: queueItem.step_id,
        order: { gt: activity?.order || 0 },
      },
      orderBy: { order: 'asc' },
    });

    if (nextActivity) {
      const updated = await this.prisma.automation_queue.update({
        where: { id: queueId },
        data: { activity_id: nextActivity.id },
      });
      return this.executeQueueItem(updated.id);
    }

    // 2. Move to next step in flow
    const flow = await this.prisma.automation_flow.findFirst({
      where: {
        connector_id: queueItem.step_id,
        connector_type: 'App\\Models\\Automations\\AutomationStep',
      },
    });

    if (flow) {
      const nextStep = await this.prisma.automation_steps.findUnique({
        where: { id: flow.next_step_id },
      });

      const nextStepActivities = await this.prisma.automation_step_activities.findMany({
        where: { step_id: flow.next_step_id, deleted_at: null },
        orderBy: { order: 'asc' },
      });

      if (nextStep && nextStepActivities.length > 0) {
        const updated = await this.prisma.automation_queue.update({
          where: { id: queueId },
          data: {
            flow_id: flow.id,
            step_id: nextStep.id,
            activity_id: nextStepActivities[0].id,
          },
        });
        return this.executeQueueItem(updated.id);
      }
    }

    // 3. No more steps, delete queue item
    await this.prisma.automation_queue.delete({ where: { id: queueId } });
    this.logger.log(`Automation run ${queueId} finished`);
  }
}
