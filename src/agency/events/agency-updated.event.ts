/**
 * Emitted whenever an agency is updated.
 * `dirtyAttributes` mirrors Laravel's $dirtyAttributes — the fields that
 * actually changed in the update so listeners can react selectively.
 */
export class AgencyUpdatedEvent {
  static readonly NAME = 'agency.updated';

  constructor(
    public readonly agencyId: bigint,
    public readonly dirtyAttributes: Record<string, any>,
    public readonly userId: bigint | null,
  ) {}
}
