/**
 * Centralized queue name registry. Use these constants whenever calling
 * BullModule.registerQueue or @Processor / @InjectQueue so that producer and
 * consumer references stay aligned.
 */
export const QUEUE_BROADCAST = 'broadcast';
export const QUEUE_AUTOMATION = 'automation';
export const QUEUE_OUTBOUND_MESSAGE = 'outbound-message';
export const QUEUE_INBOUND_WEBHOOK = 'inbound-webhook';
