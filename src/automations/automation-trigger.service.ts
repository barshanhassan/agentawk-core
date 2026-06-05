import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationProcessorService } from './automation-processor.service';
import { TRIGGER_EVENTS } from './automations.constants';
import { QuickReplyInputService } from './quick-reply-input.service';

/**
 * Bridges NestJS EventEmitter events to automation trigger activities.
 *
 * Every method here listens for one or more `<domain>.<event>` events emitted
 * elsewhere in the backend (contacts service, inbox consumer, tag mutator,
 * opportunities service, etc.), finds matching trigger activities, applies
 * any per-activity property filters (tag id, channel, stage id, keyword,
 * etc.), then enqueues the automation via the processor.
 *
 * Trigger activity event slugs come from `automations.constants.ts:TRIGGER_EVENTS`
 * — same identifiers the frontend builder saves under `activity.event`.
 *
 * Replyagent parity: each handler mirrors the corresponding observer / event
 * listener in `gateway/app/Listeners/Automations/*`.
 */
@Injectable()
export class AutomationTriggerService {
  private readonly logger = new Logger(AutomationTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: AutomationProcessorService,
    private readonly quickReply: QuickReplyInputService,
  ) {}

  // ─── Contact lifecycle ────────────────────────────────────────────

  @OnEvent('contact.created')
  async handleContactCreated(payload: { contactId: bigint; workspaceId: bigint; source?: string }) {
    return this.matchAndDispatch(TRIGGER_EVENTS.CONTACT_ADDED, payload.contactId, payload.workspaceId, payload);
  }

  @OnEvent('contact.tag_applied')
  async handleTagApplied(payload: { contactId: bigint; tagId: bigint; workspaceId: bigint }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.TAG_APPLIED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expected = props?.tag?.id ?? props?.tag_id;
        return expected == null || expected == payload.tagId.toString();
      },
    );
  }

  @OnEvent('contact.tag_removed')
  async handleTagRemoved(payload: { contactId: bigint; tagId: bigint; workspaceId: bigint }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.TAG_REMOVED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expected = props?.tag?.id ?? props?.tag_id;
        return expected == null || expected == payload.tagId.toString();
      },
    );
  }

  @OnEvent('contact.custom_field_changed')
  async handleCustomFieldChanged(payload: {
    contactId: bigint;
    fieldId: bigint;
    value: any;
    workspaceId: bigint;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.CUSTOM_FIELD_CHANGED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expected = props?.field?.id ?? props?.field_id;
        return expected == null || expected == payload.fieldId.toString();
      },
    );
  }

  @OnEvent('contact.system_field_changed')
  async handleSystemFieldChanged(payload: {
    contactId: bigint;
    field: string;
    value: any;
    workspaceId: bigint;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.SYSTEM_FIELD_CHANGED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expected = props?.field;
        return expected == null || expected === payload.field;
      },
    );
  }

  @OnEvent('contact.date_field_changed')
  async handleDateFieldChanged(payload: {
    contactId: bigint;
    field: string;
    value: any;
    workspaceId: bigint;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.DATE_FIELD_CHANGED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expected = props?.field;
        return expected == null || expected === payload.field;
      },
    );
  }

  // ─── Messages / channels ──────────────────────────────────────────

  /**
   * Generic inbound message trigger. Channel-specific narrowing handled via
   * `props.channel` (whatsapp / telegram / messenger / instagram / ...).
   */
  @OnEvent('message.inbound')
  async handleInboundMessage(payload: {
    workspaceId: bigint;
    inboxId: bigint;
    contactId?: bigint;
    channel?: string;
    text?: string;
  }) {
    if (!payload.contactId) return;

    // 0. Input-collection short-circuit. If a step is currently waiting on
    // this contact's reply (quick-reply / input activity), QuickReplyInputService
    // consumes the inbound and routes via the responded / answer_failed
    // branch. We then SKIP the generic trigger fan-out so the same message
    // doesn't also fire other auto-reply / keyword triggers.
    if (payload.channel && payload.text) {
      const consumed = await this.quickReply.tryHandleInbound({
        contactId: payload.contactId,
        channel: payload.channel,
        text: payload.text,
      });
      if (consumed) return;
    }

    // 1. Generic inbound_message triggers.
    await this.matchAndDispatch(
      TRIGGER_EVENTS.INBOUND_MESSAGE,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.channel || props.channel === payload.channel,
    );

    // 2. Channel-specific auto-reply triggers (wa_auto_reply / tg_auto_reply / ...).
    const autoReplyEvent = this.channelAutoReplyEvent(payload.channel);
    if (autoReplyEvent) {
      await this.matchAndDispatch(autoReplyEvent, payload.contactId, payload.workspaceId, payload);
    }

    // 3. Keyword triggers (wa_keyword / tg_keyword / zapi_keyword / evolution_keyword).
    const keywordEvent = this.channelKeywordEvent(payload.channel);
    if (keywordEvent && payload.text) {
      await this.matchAndDispatch(
        keywordEvent,
        payload.contactId,
        payload.workspaceId,
        payload,
        (props) => this.matchesKeyword(props, payload.text!),
      );
    }
  }

  /**
   * WhatsApp ref-start: incoming message that arrives via a wa.me link with
   * a tracking ref (e.g. wa.me/<num>?text=ref_XXX). The inbox consumer is
   * expected to emit this with `refCode` set.
   */
  @OnEvent('message.wa_ref_start')
  async handleWaRefStart(payload: {
    contactId: bigint;
    workspaceId: bigint;
    refCode?: string;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.WA_REF_START,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.ref_code || props.ref_code === payload.refCode,
    );
  }

  /**
   * IG story mentions and FB ad clicks share the same shape — channel-specific
   * inbound payload with a context hint.
   */
  @OnEvent('message.ig_story_mention')
  async handleIgStoryMention(payload: { contactId: bigint; workspaceId: bigint }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.IG_STORY_MENTION,
      payload.contactId,
      payload.workspaceId,
      payload,
    );
  }

  @OnEvent('message.ig_comment_reply')
  async handleIgCommentReply(payload: { contactId: bigint; workspaceId: bigint; postId?: string }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.IG_COMMENT_REPLY,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.post_id || props.post_id === payload.postId,
    );
  }

  @OnEvent('message.wa_ad_clicked')
  async handleWaAdClicked(payload: { contactId: bigint; workspaceId: bigint; adId?: string }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.WA_AD_CLICKED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.ad_id || props.ad_id === payload.adId,
    );
  }

  // ─── Facebook (additional) ────────────────────────────────────────

  /**
   * Facebook keyword-on-message — fires on inbound Messenger DM that matches
   * the activity's keyword set. Distinct from FB_QUICK_STARTER (ref-style URL
   * deep link) and FB_COMMENT (post comment).
   */
  @OnEvent('message.fb_keyword')
  async handleFbKeyword(payload: { contactId: bigint; workspaceId: bigint; text: string; pageId?: string }) {
    if (!payload.text) return;
    return this.matchAndDispatch(
      TRIGGER_EVENTS.FB_KEYWORD,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        if (props?.page_id && props.page_id !== payload.pageId) return false;
        return this.matchesKeyword(props, payload.text);
      },
    );
  }

  /**
   * Facebook comment trigger — fires on a comment posted to a configured
   * page/post. Optionally narrows by post_id and keyword.
   */
  @OnEvent('message.fb_comment')
  async handleFbComment(payload: {
    contactId: bigint;
    workspaceId: bigint;
    text?: string;
    pageId?: string;
    postId?: string;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.FB_COMMENT,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        if (props?.page_id && props.page_id !== payload.pageId) return false;
        if (props?.post_id && props.post_id !== payload.postId) return false;
        if (props?.keywords?.length && payload.text) {
          return this.matchesKeyword(props, payload.text);
        }
        return true;
      },
    );
  }

  /**
   * Facebook Messenger ref-start — fires when a user lands via a m.me link
   * containing a `ref=` token (e.g. `https://m.me/<pageId>?ref=summer_promo`).
   */
  @OnEvent('message.fb_messenger_ref_start')
  async handleFbMessengerRefStart(payload: {
    contactId: bigint;
    workspaceId: bigint;
    ref?: string;
    pageId?: string;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.FB_MESSENGER_REF_START,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        if (props?.page_id && props.page_id !== payload.pageId) return false;
        if (props?.ref && props.ref !== payload.ref) return false;
        return true;
      },
    );
  }

  /**
   * Facebook Messenger sponsored-message topic events. Replyagent emits
   * `fb_topic_subscribed` when a user opts into a Messenger marketing topic,
   * `fb_topic_sent` when a sponsored message has been sent, and
   * `fb_topic_limit_reach` when the OTN quota is hit.
   * Topic id (if present) narrows the match.
   */
  @OnEvent('messenger.topic_subscribed')
  async handleFbTopicSubscribed(payload: {
    contactId: bigint;
    workspaceId: bigint;
    topicId?: string;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.FB_TOPIC_SUBSCRIBED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.topic_id || props.topic_id === payload.topicId,
    );
  }

  @OnEvent('messenger.topic_sent')
  async handleFbTopicSent(payload: {
    contactId: bigint;
    workspaceId: bigint;
    topicId?: string;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.FB_TOPIC_SENT,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.topic_id || props.topic_id === payload.topicId,
    );
  }

  @OnEvent('messenger.topic_limit_reach')
  async handleFbTopicLimitReach(payload: {
    contactId: bigint;
    workspaceId: bigint;
    topicId?: string;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.FB_TOPIC_LIMIT_REACH,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.topic_id || props.topic_id === payload.topicId,
    );
  }

  // ─── Conversation lifecycle ───────────────────────────────────────

  @OnEvent('conversation.marked_as_done')
  async handleConversationDone(payload: {
    contactId: bigint;
    workspaceId: bigint;
    inboxId: bigint;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.CONVERSATION_MARKED_AS_DONE,
      payload.contactId,
      payload.workspaceId,
      payload,
    );
  }

  @OnEvent('conversation.assigned')
  async handleConversationAssigned(payload: {
    contactId: bigint;
    workspaceId: bigint;
    userId: bigint | null;
    inboxId: bigint;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.CONVERSATION_ASSIGNED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => !props?.user?.id || props.user.id == payload.userId?.toString(),
    );
  }

  // ─── Pipeline / opportunities ─────────────────────────────────────

  @OnEvent('opportunity.stage_moved')
  async handleOpportunityMoved(payload: {
    contactId: bigint;
    pipelineId: bigint;
    stageId: bigint;
    workspaceId: bigint;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.OPPORTUNITY_STAGE_MOVED,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expectedStage = props?.stage?.id ?? props?.stage_id;
        return expectedStage == null || expectedStage == payload.stageId.toString();
      },
    );
  }

  // ─── Programmatic ─────────────────────────────────────────────────

  @OnEvent('automation.start')
  async handleAutomationStart(payload: {
    automationId: bigint;
    triggerActivityId: bigint;
    contactId: bigint;
    workspaceId: bigint;
  }) {
    // Called by ActionHandler.startAutomation — direct enqueue.
    return this.processor.triggerAutomation(payload.triggerActivityId, payload.contactId);
  }

  /**
   * Visual API trigger — fired by the public webhook controller after it
   * persists the request + resolves the contact. We narrow to activities
   * whose `properties.api_trigger_id` matches the trigger that fired.
   */
  @OnEvent('integration.api_trigger')
  async handleApiTrigger(payload: {
    apiTriggerId: bigint;
    contactId: bigint;
    workspaceId: bigint;
    payload: any;
  }) {
    return this.matchAndDispatch(
      TRIGGER_EVENTS.API_TRIGGER,
      payload.contactId,
      payload.workspaceId,
      payload,
      (props) => {
        const expected = props?.api_trigger?.id ?? props?.api_trigger_id;
        return expected == null || expected == payload.apiTriggerId.toString();
      },
    );
  }

  // ─── Core matching engine ─────────────────────────────────────────

  /**
   * Find every active trigger activity whose `event` equals `eventName`,
   * confirm the parent automation belongs to the contact's workspace and
   * is active, optionally apply a per-activity property filter, and dispatch
   * each match through the processor.
   */
  private async matchAndDispatch(
    eventName: string,
    contactId: bigint,
    workspaceId: bigint,
    _payload: any,
    propsFilter?: (props: any) => boolean,
  ) {
    const triggers = await this.prisma.automation_step_activities.findMany({
      where: { event: eventName, deleted_at: null },
    });

    for (const trigger of triggers) {
      const automation = await this.lookupAutomationForActivity(trigger);
      if (!automation) continue;
      if (automation.workspace_id !== workspaceId) continue;
      if (automation.status !== 'active') continue;

      // Apply per-activity property filter (channel narrowing, tag id, etc.).
      if (propsFilter) {
        const props = this.parseProps(trigger.properties);
        if (!propsFilter(props)) continue;
      }

      this.logger.log(
        `Trigger match: event=${eventName} automation=${automation.id} contact=${contactId}`,
      );
      await this.processor.triggerAutomation(trigger.id, contactId);
    }
  }

  private async lookupAutomationForActivity(activity: { step_id: bigint }) {
    const step = await this.prisma.automation_steps.findUnique({
      where: { id: activity.step_id },
    });
    if (!step) return null;
    const version = await this.prisma.automation_versions.findUnique({
      where: { id: step.automation_version_id },
    });
    if (!version) return null;
    return this.prisma.automations.findUnique({
      where: { id: version.automation_id },
    });
  }

  private parseProps(raw: any): any {
    if (raw == null) return {};
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return raw;
  }

  private channelAutoReplyEvent(channel?: string): string | null {
    switch (channel) {
      case 'whatsapp':
        return TRIGGER_EVENTS.WA_AUTO_REPLY;
      case 'telegram':
        return TRIGGER_EVENTS.TG_AUTO_REPLY;
      case 'messenger':
      case 'facebook':
        return TRIGGER_EVENTS.FB_AUTO_REPLY;
      case 'instagram':
        return TRIGGER_EVENTS.IG_AUTO_REPLY;
      case 'webchat':
        return TRIGGER_EVENTS.WC_AUTO_REPLY;
      case 'zapi':
        return TRIGGER_EVENTS.ZAPI_AUTO_REPLY;
      case 'evolution':
        return TRIGGER_EVENTS.EVOLUTION_AUTO_REPLY;
      default:
        return null;
    }
  }

  private channelKeywordEvent(channel?: string): string | null {
    switch (channel) {
      case 'whatsapp':
        return TRIGGER_EVENTS.WA_KEYWORD;
      case 'telegram':
        return TRIGGER_EVENTS.TG_KEYWORD;
      case 'zapi':
        return TRIGGER_EVENTS.ZAPI_KEYWORD;
      case 'evolution':
        return TRIGGER_EVENTS.EVOLUTION_KEYWORD;
      default:
        return null;
    }
  }

  /**
   * Match keyword(s) against the inbound message text.
   *
   * Supported `props.check` / `props.match_type` modes (mirrors replyagent's
   * `AutomationHelper::matchKeywords()`):
   *   - 'is' / 'exact'                  — equality
   *   - 'contains' / 'doesnot_contains' — substring presence / absence
   *   - 'begins_with' / 'starts_with'   — prefix
   *   - 'ends_with'                     — suffix
   *   - 'word'                          — whole-word match (accent-tolerant)
   *   - 'thumbs_up'                     — special: WhatsApp emoji 👍 reaction
   *
   * Inversion (`doesnot_contains`) returns true when NO keyword is contained.
   * Case-insensitive by default.
   */
  private matchesKeyword(props: any, text: string): boolean {
    const keywords: string[] = Array.isArray(props?.keywords)
      ? props.keywords
      : props?.keyword
      ? [String(props.keyword)]
      : [];

    const matchType = props?.check ?? props?.match_type ?? 'contains';

    // thumbs_up doesn't need a keyword list — it matches a literal emoji.
    if (matchType === 'thumbs_up') {
      return text.includes('👍') || text.trim() === '👍';
    }

    if (keywords.length === 0) return false;

    const caseSensitive = !!props?.case_sensitive;
    const haystack = caseSensitive ? text : text.toLowerCase();

    // For doesnot_contains we invert: returns true only when NO keyword
    // appears in the haystack.
    if (matchType === 'doesnot_contains' || matchType === 'does_not_contain') {
      for (const kw of keywords) {
        const needle = caseSensitive ? kw : kw.toLowerCase();
        if (haystack.includes(needle)) return false;
      }
      return true;
    }

    for (const kw of keywords) {
      const needle = caseSensitive ? kw : kw.toLowerCase();
      switch (matchType) {
        case 'is':
        case 'exact':
          if (haystack === needle) return true;
          break;
        case 'begins_with':
        case 'starts_with':
          if (haystack.startsWith(needle)) return true;
          break;
        case 'ends_with':
          if (haystack.endsWith(needle)) return true;
          break;
        case 'word': {
          // Whole-word match with unicode boundaries; escape regex metachars.
          const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'u');
          if (re.test(haystack)) return true;
          break;
        }
        case 'contains':
        default:
          if (haystack.includes(needle)) return true;
          break;
      }
    }
    return false;
  }
}
