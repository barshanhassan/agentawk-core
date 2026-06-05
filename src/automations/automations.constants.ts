/**
 * Canonical registry for the Smart Flows (Automations) feature.
 *
 * Mirrors replyagent's automation surface — every trigger event, action slug,
 * step type, channel, and condition operator the editor / processor knows
 * about lives here. The integrations endpoint serves this to the frontend
 * pickers; the processor dispatches off these same identifiers.
 *
 * RULE: never add an automation behavior in the codebase that isn't reflected
 * here. The frontend builder reads this list to populate dropdowns; if a
 * trigger/action/step type isn't here, the builder won't expose it.
 */

// ─── STEP TYPES ───────────────────────────────────────────────────────
// A "step" is a node on the flow canvas. The processor branches off
// step.type to know whether to send a message, evaluate a condition,
// wait, or run an action.

export const STEP_TYPES = {
  TRIGGER: 'trigger',
  // Messaging channels — each dispatches via MessagingService.
  WHATSAPP: 'whatsapp',
  TELEGRAM: 'telegram',
  MESSENGER: 'messenger',
  INSTAGRAM: 'instagram',
  WEBCHAT: 'webchat',
  TWILIO_SMS: 'twilio_sms',
  TWILIO_CALL: 'twilio_call',
  ZAPI: 'zapi',
  EVOLUTION: 'evolution',
  EMAIL: 'email',
  // Control-flow.
  ACTION: 'action',
  CONDITION: 'condition',
  DELAY: 'delay',
  RANDOMIZER: 'randomizer',
  SPLITTER: 'splitter',
  SMART_LOOP: 'smart_loop',
} as const;

export type StepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];

export const CHANNEL_STEP_TYPES: StepType[] = [
  STEP_TYPES.WHATSAPP,
  STEP_TYPES.TELEGRAM,
  STEP_TYPES.MESSENGER,
  STEP_TYPES.INSTAGRAM,
  STEP_TYPES.WEBCHAT,
  STEP_TYPES.TWILIO_SMS,
  STEP_TYPES.TWILIO_CALL,
  STEP_TYPES.ZAPI,
  STEP_TYPES.EVOLUTION,
  STEP_TYPES.EMAIL,
];

// ─── TRIGGER EVENTS ───────────────────────────────────────────────────
// activity.event values that start an automation. The Trigger Service
// emits / listens to NestJS EventEmitter events and matches activities
// by these slugs.

export const TRIGGER_EVENTS = {
  // Manual / system.
  DEFAULT: 'default',
  CONTACT_ADDED: 'contact_added',
  CONTACT_UPDATED: 'contact_updated',

  // Fields.
  TAG_APPLIED: 'tag_applied',
  TAG_REMOVED: 'tag_removed',
  CUSTOM_FIELD_CHANGED: 'custom_field_changed',
  SYSTEM_FIELD_CHANGED: 'system_field_changed',
  DATE_FIELD_CHANGED: 'date_field_changed',

  // Messages (channel-agnostic — narrow with properties.channel).
  INBOUND_MESSAGE: 'inbound_message',

  // WhatsApp-specific.
  WA_AUTO_REPLY: 'wa_auto_reply',
  WA_KEYWORD: 'wa_keyword',
  WA_REF_START: 'wa_ref_start', // URL trigger (https://wa.me/?text=ref_xxx)
  WA_AD_CLICKED: 'wa_ad_clicked',

  // Telegram-specific.
  TG_AUTO_REPLY: 'tg_auto_reply',
  TG_KEYWORD: 'tg_keyword',

  // Facebook Messenger.
  FB_AUTO_REPLY: 'fb_auto_reply',
  FB_QUICK_STARTER: 'fb_quick_starter',
  FB_KEYWORD: 'facebook_keyword',
  FB_COMMENT: 'facebook_comment',
  FB_MESSENGER_REF_START: 'fb_messenger_ref_start',
  FB_TOPIC_SUBSCRIBED: 'fb_topic_subscribed',
  FB_TOPIC_SENT: 'fb_topic_sent',
  FB_TOPIC_LIMIT_REACH: 'fb_topic_limit_reach',

  // Instagram.
  IG_AUTO_REPLY: 'ig_auto_reply',
  IG_QUICK_STARTER: 'ig_quick_starter',
  IG_STORY_MENTION: 'ig_story_mention',
  IG_COMMENT_REPLY: 'ig_comment_reply',

  // Webchat.
  WC_AUTO_REPLY: 'wc_auto_reply',

  // Z-API (WhatsApp QR).
  ZAPI_AUTO_REPLY: 'zapi_auto_reply',
  ZAPI_KEYWORD: 'zapi_keyword',
  ZAPI_REF_START: 'zapi_ref_start',

  // Evolution API.
  EVOLUTION_AUTO_REPLY: 'evolution_auto_reply',
  EVOLUTION_KEYWORD: 'evolution_keyword',
  EVOLUTION_REF_START: 'evolution_ref_start',

  // Twilio.
  TWILIO_SMS_INBOUND: 'twilio_sms_inbound',
  TWILIO_KEYWORD: 'twilio_keyword',

  // Conversation lifecycle.
  CONVERSATION_MARKED_AS_DONE: 'conversation_marked_as_done',
  CONVERSATION_ASSIGNED: 'conversation_assigned',

  // CRM / Pipeline.
  OPPORTUNITY_STAGE_MOVED: 'opportunity_stage_moved',

  // Programmatic.
  BROADCAST: 'broadcast',
  API_TRIGGER: 'api_trigger',
} as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[keyof typeof TRIGGER_EVENTS];

/**
 * UI grouping for the trigger picker. The frontend renders these as
 * tabs / accordion sections in the trigger modal.
 */
export const TRIGGER_GROUPS: Array<{
  key: string;
  label: string;
  triggers: TriggerEvent[];
}> = [
  {
    key: 'events',
    label: 'Events',
    triggers: [
      TRIGGER_EVENTS.DEFAULT,
      TRIGGER_EVENTS.CONTACT_ADDED,
      TRIGGER_EVENTS.TAG_APPLIED,
      TRIGGER_EVENTS.TAG_REMOVED,
      TRIGGER_EVENTS.CUSTOM_FIELD_CHANGED,
      TRIGGER_EVENTS.SYSTEM_FIELD_CHANGED,
      TRIGGER_EVENTS.DATE_FIELD_CHANGED,
      TRIGGER_EVENTS.OPPORTUNITY_STAGE_MOVED,
      TRIGGER_EVENTS.CONVERSATION_MARKED_AS_DONE,
      TRIGGER_EVENTS.CONVERSATION_ASSIGNED,
      TRIGGER_EVENTS.API_TRIGGER,
      TRIGGER_EVENTS.BROADCAST,
    ],
  },
  {
    key: 'whatsapp',
    label: 'WhatsApp',
    triggers: [
      TRIGGER_EVENTS.WA_AUTO_REPLY,
      TRIGGER_EVENTS.WA_KEYWORD,
      TRIGGER_EVENTS.WA_REF_START,
      TRIGGER_EVENTS.WA_AD_CLICKED,
    ],
  },
  {
    key: 'telegram',
    label: 'Telegram',
    triggers: [TRIGGER_EVENTS.TG_AUTO_REPLY, TRIGGER_EVENTS.TG_KEYWORD],
  },
  {
    key: 'messenger',
    label: 'Messenger',
    triggers: [
      TRIGGER_EVENTS.FB_AUTO_REPLY,
      TRIGGER_EVENTS.FB_QUICK_STARTER,
      TRIGGER_EVENTS.FB_KEYWORD,
      TRIGGER_EVENTS.FB_COMMENT,
      TRIGGER_EVENTS.FB_MESSENGER_REF_START,
      TRIGGER_EVENTS.FB_TOPIC_SUBSCRIBED,
      TRIGGER_EVENTS.FB_TOPIC_SENT,
      TRIGGER_EVENTS.FB_TOPIC_LIMIT_REACH,
    ],
  },
  {
    key: 'instagram',
    label: 'Instagram',
    triggers: [
      TRIGGER_EVENTS.IG_AUTO_REPLY,
      TRIGGER_EVENTS.IG_QUICK_STARTER,
      TRIGGER_EVENTS.IG_STORY_MENTION,
      TRIGGER_EVENTS.IG_COMMENT_REPLY,
    ],
  },
  {
    key: 'webchat',
    label: 'Webchat',
    triggers: [TRIGGER_EVENTS.WC_AUTO_REPLY],
  },
  {
    key: 'zapi',
    label: 'Z-API',
    triggers: [
      TRIGGER_EVENTS.ZAPI_AUTO_REPLY,
      TRIGGER_EVENTS.ZAPI_KEYWORD,
      TRIGGER_EVENTS.ZAPI_REF_START,
    ],
  },
  {
    key: 'evolution',
    label: 'Evolution',
    triggers: [
      TRIGGER_EVENTS.EVOLUTION_AUTO_REPLY,
      TRIGGER_EVENTS.EVOLUTION_KEYWORD,
      TRIGGER_EVENTS.EVOLUTION_REF_START,
    ],
  },
  {
    key: 'twilio',
    label: 'Twilio',
    triggers: [TRIGGER_EVENTS.TWILIO_SMS_INBOUND, TRIGGER_EVENTS.TWILIO_KEYWORD],
  },
];

// ─── ACTION SLUGS ─────────────────────────────────────────────────────
// activity.properties.slug values for `step.type === 'action'`. The
// processor's `handleAction()` dispatches off these.

export const ACTION_SLUGS = {
  // Tags.
  ADD_TAG: 'add_tag',
  REMOVE_TAG: 'remove_tag',

  // Custom fields.
  ADD_CUSTOM_FIELD: 'add_custom_field',
  REMOVE_CUSTOM_FIELD: 'remove_custom_field',
  JSON_TO_CUSTOM_FIELDS: 'json_to_custom_fields',

  // System fields.
  SET_SYSTEM_FIELD: 'set_system_field',
  UNSET_SYSTEM_FIELD: 'unset_system_field',
  SET_LANGUAGE: 'set_language',
  SET_LOCALE: 'set_locale',
  SET_TIMEZONE: 'set_timezone',

  // External HTTP / webhooks.
  EXTERNAL_REQUEST: 'external_request',
  MAKE_HOOK: 'make_hook',

  // AI providers.
  CHATGPT_QUESTION: 'chatgpt_question',
  CHATGPT_COMPLETION: 'chatgpt_completion',
  CHATGPT_IMAGE_RECOGNITION: 'chatgpt_image_recognition',
  CHATGPT_TEXT_TO_SPEECH: 'chatgpt_text_to_speech',
  DIFY_QUESTION: 'dify_question',
  AI_STUDIO_VISION: 'ai_studio_vision',
  AI_STUDIO_TEXT_TO_SPEECH: 'ai_studio_text_to_speech',
  ELEVENLABS_TEXT_TO_SPEECH: 'elevenlabs_text_to_speech',
  MS_TEXT_TO_SPEECH: 'ms_text_to_speech',

  // CRM / conversion APIs.
  ACTIVE_CAMPAIGN: 'active_campaign',
  CAPI: 'capi',
  META_CONVERSIONS: 'meta_conversions',

  // Baserow.
  BASEROW_ADD_ROW: 'baserow_add_row',
  BASEROW_GET_ROW: 'baserow_get_row',
  BASEROW_UPDATE_ROW: 'baserow_update_row',
  BASEROW_DELETE_ROW: 'baserow_delete_row',
  BASEROW_TO_JSON: 'baserow_to_json',

  // Channel opting (subscribe / unsubscribe).
  WHATSAPP_OPTING: 'whatsapp_opting',
  TELEGRAM_OPTING: 'telegram_opting',
  MESSENGER_OPTING: 'messenger_opting',
  INSTAGRAM_OPTING: 'instagram_opting',
  WEBCHAT_OPTING: 'webchat_opting',
  EMAIL_OPTING: 'email_opting',
  SMS_OPTING: 'sms_opting',
  CALL_OPTING: 'call_opting',
  ZAPI_OPTING: 'zapi_opting',
  EVOLUTION_OPTING: 'evolution_opting',

  // Flow control.
  START_AUTOMATION: 'start_automation',
  REMOVE_FROM_FLOW: 'remove_from_flow',

  // Conversation management.
  ASSIGN_CONVERSATION: 'assign_conversation',
  MANAGE_CONVERSATIONS: 'manage_conversations',
  NOTIFY_AGENT: 'notify_agent',
  CLOSE_CONVERSATION: 'close_conversation',

  // Pipeline / opportunities.
  CREATE_OPPORTUNITY: 'create_opportunity',
  UPDATE_OPPORTUNITY: 'update_opportunity',

  // Contact.
  DELETE_CONTACT: 'delete_contact',

  // Misc integrations.
  CAL_CALENDAR: 'cal_calendar',
  CLOUDINARY_IMAGE: 'cloudinary_image',
  GET_REPORT: 'get_report',
  TRIGGER_REPORT: 'trigger_report',
  SHARE_CLONEKIT: 'share_clonekit',
  UNSTRACT: 'unstract',
  WOOVI: 'woovi',
} as const;

export type ActionSlug = (typeof ACTION_SLUGS)[keyof typeof ACTION_SLUGS];

/**
 * UI grouping for the action picker. The frontend renders these as
 * sections in the action modal.
 */
export const ACTION_GROUPS: Array<{
  key: string;
  label: string;
  actions: Array<{ slug: ActionSlug; label: string; icon?: string }>;
}> = [
  {
    key: 'tags',
    label: 'Tags & Fields',
    actions: [
      { slug: ACTION_SLUGS.ADD_TAG, label: 'Add tag' },
      { slug: ACTION_SLUGS.REMOVE_TAG, label: 'Remove tag' },
      { slug: ACTION_SLUGS.ADD_CUSTOM_FIELD, label: 'Set custom field' },
      { slug: ACTION_SLUGS.REMOVE_CUSTOM_FIELD, label: 'Remove custom field' },
      { slug: ACTION_SLUGS.JSON_TO_CUSTOM_FIELDS, label: 'JSON → custom fields' },
      { slug: ACTION_SLUGS.SET_SYSTEM_FIELD, label: 'Set system field' },
      { slug: ACTION_SLUGS.UNSET_SYSTEM_FIELD, label: 'Unset system field' },
      { slug: ACTION_SLUGS.SET_LANGUAGE, label: 'Set language' },
      { slug: ACTION_SLUGS.SET_LOCALE, label: 'Set locale' },
      { slug: ACTION_SLUGS.SET_TIMEZONE, label: 'Set timezone' },
    ],
  },
  {
    key: 'http',
    label: 'External',
    actions: [
      { slug: ACTION_SLUGS.EXTERNAL_REQUEST, label: 'HTTP request' },
      { slug: ACTION_SLUGS.MAKE_HOOK, label: 'Make.com webhook' },
    ],
  },
  {
    key: 'ai',
    label: 'AI',
    actions: [
      { slug: ACTION_SLUGS.CHATGPT_QUESTION, label: 'ChatGPT: ask question' },
      { slug: ACTION_SLUGS.CHATGPT_COMPLETION, label: 'ChatGPT: completion' },
      { slug: ACTION_SLUGS.CHATGPT_IMAGE_RECOGNITION, label: 'ChatGPT: image recognition' },
      { slug: ACTION_SLUGS.CHATGPT_TEXT_TO_SPEECH, label: 'ChatGPT: text to speech' },
      { slug: ACTION_SLUGS.DIFY_QUESTION, label: 'Dify: ask question' },
      { slug: ACTION_SLUGS.AI_STUDIO_VISION, label: 'AI Studio: vision' },
      { slug: ACTION_SLUGS.AI_STUDIO_TEXT_TO_SPEECH, label: 'AI Studio: text to speech' },
      { slug: ACTION_SLUGS.ELEVENLABS_TEXT_TO_SPEECH, label: 'ElevenLabs: text to speech' },
      { slug: ACTION_SLUGS.MS_TEXT_TO_SPEECH, label: 'Microsoft: text to speech' },
    ],
  },
  {
    key: 'crm',
    label: 'CRM / Conversions',
    actions: [
      { slug: ACTION_SLUGS.ACTIVE_CAMPAIGN, label: 'ActiveCampaign' },
      { slug: ACTION_SLUGS.CAPI, label: 'Meta Conversions API' },
      { slug: ACTION_SLUGS.META_CONVERSIONS, label: 'Meta Conversions (alias)' },
    ],
  },
  {
    key: 'baserow',
    label: 'Baserow',
    actions: [
      { slug: ACTION_SLUGS.BASEROW_ADD_ROW, label: 'Baserow: add row' },
      { slug: ACTION_SLUGS.BASEROW_GET_ROW, label: 'Baserow: get row' },
      { slug: ACTION_SLUGS.BASEROW_UPDATE_ROW, label: 'Baserow: update row' },
      { slug: ACTION_SLUGS.BASEROW_DELETE_ROW, label: 'Baserow: delete row' },
      { slug: ACTION_SLUGS.BASEROW_TO_JSON, label: 'Baserow → JSON' },
    ],
  },
  {
    key: 'opting',
    label: 'Channel opt-in/out',
    actions: [
      { slug: ACTION_SLUGS.WHATSAPP_OPTING, label: 'WhatsApp opt-in/out' },
      { slug: ACTION_SLUGS.TELEGRAM_OPTING, label: 'Telegram opt-in/out' },
      { slug: ACTION_SLUGS.MESSENGER_OPTING, label: 'Messenger opt-in/out' },
      { slug: ACTION_SLUGS.INSTAGRAM_OPTING, label: 'Instagram opt-in/out' },
      { slug: ACTION_SLUGS.WEBCHAT_OPTING, label: 'Webchat opt-in/out' },
      { slug: ACTION_SLUGS.EMAIL_OPTING, label: 'Email opt-in/out' },
      { slug: ACTION_SLUGS.SMS_OPTING, label: 'SMS opt-in/out' },
      { slug: ACTION_SLUGS.CALL_OPTING, label: 'Call opt-in/out' },
      { slug: ACTION_SLUGS.ZAPI_OPTING, label: 'Z-API opt-in/out' },
      { slug: ACTION_SLUGS.EVOLUTION_OPTING, label: 'Evolution opt-in/out' },
    ],
  },
  {
    key: 'flow',
    label: 'Flow control',
    actions: [
      { slug: ACTION_SLUGS.START_AUTOMATION, label: 'Start another automation' },
      { slug: ACTION_SLUGS.REMOVE_FROM_FLOW, label: 'Remove from this automation' },
    ],
  },
  {
    key: 'conversation',
    label: 'Conversation',
    actions: [
      { slug: ACTION_SLUGS.ASSIGN_CONVERSATION, label: 'Assign conversation' },
      { slug: ACTION_SLUGS.MANAGE_CONVERSATIONS, label: 'Manage conversations' },
      { slug: ACTION_SLUGS.NOTIFY_AGENT, label: 'Notify agent' },
      { slug: ACTION_SLUGS.CLOSE_CONVERSATION, label: 'Close conversation' },
    ],
  },
  {
    key: 'pipeline',
    label: 'Pipeline',
    actions: [
      { slug: ACTION_SLUGS.CREATE_OPPORTUNITY, label: 'Create opportunity' },
      { slug: ACTION_SLUGS.UPDATE_OPPORTUNITY, label: 'Update opportunity' },
    ],
  },
  {
    key: 'contact',
    label: 'Contact',
    actions: [{ slug: ACTION_SLUGS.DELETE_CONTACT, label: 'Delete contact' }],
  },
  {
    key: 'misc',
    label: 'Other integrations',
    actions: [
      { slug: ACTION_SLUGS.CAL_CALENDAR, label: 'Cal.com booking' },
      { slug: ACTION_SLUGS.CLOUDINARY_IMAGE, label: 'Cloudinary image transform' },
      { slug: ACTION_SLUGS.GET_REPORT, label: 'Get report' },
      { slug: ACTION_SLUGS.TRIGGER_REPORT, label: 'Trigger report' },
      { slug: ACTION_SLUGS.SHARE_CLONEKIT, label: 'Share clone kit' },
      { slug: ACTION_SLUGS.UNSTRACT, label: 'Unstract document' },
      { slug: ACTION_SLUGS.WOOVI, label: 'Woovi payment' },
    ],
  },
];

// ─── CONDITION OPERATORS ──────────────────────────────────────────────
// For the Condition step type — operators per value type.

export const CONDITION_OPERATORS = {
  TEXT: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  NUMBER: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  DATE: ['before', 'after', 'on', 'between', 'within_last', 'in_next'],
  BOOLEAN: ['is_true', 'is_false'],
  ARRAY: ['has', 'has_not', 'any_of', 'all_of', 'none_of'],
} as const;

export const CONDITION_TYPES = [
  { key: 'text', label: 'Text', operators: CONDITION_OPERATORS.TEXT },
  { key: 'number', label: 'Number', operators: CONDITION_OPERATORS.NUMBER },
  { key: 'date', label: 'Date', operators: CONDITION_OPERATORS.DATE },
  { key: 'boolean', label: 'Boolean', operators: CONDITION_OPERATORS.BOOLEAN },
  { key: 'tag', label: 'Tag', operators: CONDITION_OPERATORS.ARRAY },
  { key: 'source', label: 'Source', operators: CONDITION_OPERATORS.TEXT },
  { key: 'current_time', label: 'Current time', operators: CONDITION_OPERATORS.DATE },
  { key: 'message_window', label: '24h message window', operators: CONDITION_OPERATORS.BOOLEAN },
  { key: 'language', label: 'Language', operators: CONDITION_OPERATORS.TEXT },
  { key: 'locale', label: 'Locale', operators: CONDITION_OPERATORS.TEXT },
  { key: 'timezone', label: 'Timezone', operators: CONDITION_OPERATORS.TEXT },
  { key: 'gender', label: 'Gender', operators: CONDITION_OPERATORS.TEXT },
  { key: 'country_code', label: 'Country code', operators: CONDITION_OPERATORS.TEXT },
  { key: 'contact_id', label: 'Contact ID', operators: CONDITION_OPERATORS.NUMBER },
  { key: 'subscribed', label: 'Subscribed', operators: CONDITION_OPERATORS.BOOLEAN },
  { key: 'opting', label: 'Channel opted-in', operators: CONDITION_OPERATORS.BOOLEAN },
  { key: 'last_message', label: 'Last message (any channel)', operators: CONDITION_OPERATORS.DATE },
  { key: 'whatsapp_last_message', label: 'WhatsApp last message', operators: CONDITION_OPERATORS.TEXT },
  { key: 'telegram_last_message', label: 'Telegram last message', operators: CONDITION_OPERATORS.TEXT },
  { key: 'messenger_last_message', label: 'Messenger last message', operators: CONDITION_OPERATORS.TEXT },
  { key: 'instagram_last_message', label: 'Instagram last message', operators: CONDITION_OPERATORS.TEXT },
  { key: 'zapi_last_message', label: 'Z-API last message', operators: CONDITION_OPERATORS.TEXT },
  { key: 'twilio_last_message', label: 'Twilio last message', operators: CONDITION_OPERATORS.TEXT },
  { key: 'messenger_otn', label: 'Messenger OTN', operators: CONDITION_OPERATORS.BOOLEAN },
] as const;

// ─── AUTOMATION STATUS ────────────────────────────────────────────────
// Mirror of the Prisma enum `automations_status`.

export const AUTOMATION_STATUSES = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  UNPUBLISHED: 'unpublished',
  ARCHIVE: 'archive',
  ERROR: 'error',
  DELETE: 'delete',
} as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[keyof typeof AUTOMATION_STATUSES];

// ─── QUICK-REPLY FOLLOWUP DEFAULTS ────────────────────────────────────
// Default shape mirrored from replyagent's config/automations.php templates.

export const QUICK_REPLY_DEFAULTS = {
  followUp: false,
  followUpUnit: 5,
  followUpInterval: 'minutes',
  retry: false,
  retryAttempts: 2,
  retryMessage: 'Please, tap one of the options below 👇',
} as const;

// ─── DELAY UNITS ──────────────────────────────────────────────────────

export const DELAY_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks'] as const;
export type DelayUnit = (typeof DELAY_UNITS)[number];
