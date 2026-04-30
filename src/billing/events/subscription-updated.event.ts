/**
 * Emitted whenever a billing_subscription row is updated.
 * Mirrors gateway's SubscriptionUpdated event with $dirty_attributes
 * + $original_attributes payload so listeners can react to plan/status changes.
 */
export class SubscriptionUpdatedEvent {
  static readonly NAME = 'subscription.updated';

  constructor(
    public readonly subscriptionId: bigint,
    public readonly dirtyAttributes: Record<string, any>,
    public readonly originalAttributes: Record<string, any>,
  ) {}
}
