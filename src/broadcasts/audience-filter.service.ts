import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AudienceFilterService {
  private readonly logger = new Logger(AudienceFilterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAudienceContactIds(workspaceId: bigint, filterJson: string): Promise<bigint[]> {
    const filters = JSON.parse(filterJson || '{}');
    if (!filters.items || filters.items.length === 0) {
      const contacts = await this.prisma.contacts.findMany({
        where: { workspace_id: workspaceId, deleted_at: null },
        select: { id: true }
      });
      return contacts.map(c => c.id);
    }

    const condition = filters.condition || 'all'; // all, any, not_all, not_any
    
    // We'll collect sets of IDs for each filter and then perform set operations
    const filterResults: Set<bigint>[] = [];

    for (const item of filters.items) {
      const result = await this.executeSingleFilter(workspaceId, item);
      filterResults.push(result);
    }

    if (filterResults.length === 0) return [];

    let finalIds: Set<bigint>;

    if (condition === 'all') {
      finalIds = filterResults.reduce((acc, current) => new Set([...acc].filter(x => current.has(x))));
    } else if (condition === 'any') {
      finalIds = new Set(filterResults.flatMap(s => Array.from(s)));
    } else if (condition === 'not_all') {
      // Intersection of all, then invert
      const intersection = filterResults.reduce((acc, current) => new Set([...acc].filter(x => current.has(x))));
      const allContacts = await this.getAllContactIds(workspaceId);
      finalIds = new Set(allContacts.filter(id => !intersection.has(id)));
    } else if (condition === 'not_any') {
      // Union of all, then invert
      const union = new Set(filterResults.flatMap(s => Array.from(s)));
      const allContacts = await this.getAllContactIds(workspaceId);
      finalIds = new Set(allContacts.filter(id => !union.has(id)));
    } else {
      finalIds = filterResults[0];
    }

    return Array.from(finalIds);
  }

  private async executeSingleFilter(workspaceId: bigint, filter: any): Promise<Set<bigint>> {
    const { module, key, value, filter: filterType } = filter;
    let contactIds: bigint[] = [];

    switch (module) {
      case 'contact':
        contactIds = await this.filterContactModule(workspaceId, key, filterType, value);
        break;
      case 'tag':
        contactIds = await this.filterTagModule(workspaceId, key, filterType, value);
        break;
      case 'custom_field':
        contactIds = await this.filterCustomFieldModule(workspaceId, key, filterType, value);
        break;
      default:
        // Not implemented yet (mobile_number, whatsapp, email, opportunity…).
        // Matching nobody is the safe default — see filterContactModule.
        this.logger.warn(`executeSingleFilter: unsupported module "${module}" — matching no contacts`);
    }

    return new Set(contactIds);
  }

  private async filterContactModule(workspaceId: bigint, key: string, filterType: string, value: any): Promise<bigint[]> {
    // Only these keys/operators are implemented. Anything else must match
    // NOBODY: falling through with an unfiltered `where` would silently return
    // every contact in the workspace and blast the broadcast to all of them.
    if (key !== 'full_name' && key !== 'first_name' && key !== 'last_name') {
      this.logger.warn(`filterContactModule: unsupported key "${key}" — matching no contacts`);
      return [];
    }
    if (filterType !== 'is' && filterType !== 'contain') {
      this.logger.warn(`filterContactModule: unsupported operator "${filterType}" — matching no contacts`);
      return [];
    }

    const where: any = { workspace_id: workspaceId, deleted_at: null };
    where[key] = filterType === 'contain' ? { contains: value } : value;

    const contacts = await this.prisma.contacts.findMany({ where, select: { id: true } });
    return contacts.map(c => c.id);
  }

  private async filterTagModule(workspaceId: bigint, key: string, filterType: string, value: any): Promise<bigint[]> {
    // value is usually { name: 'Tag Name' } or { id: 'Tag ID' }
    const tagName = value.name;
    const tagLinks = await this.prisma.tag_links.findMany({
      where: {
        name: tagName,
        linkable_type: 'App\\Models\\Contact'
      },
      select: { linkable_id: true }
    });
    return tagLinks.map(tl => tl.linkable_id);
  }

  private async filterCustomFieldModule(workspaceId: bigint, key: string, filterType: string, value: any): Promise<bigint[]> {
    // key is the slug of the custom field
    const cf = await this.prisma.custom_fields.findFirst({ where: { workspace_id: workspaceId, slug: key } });
    if (!cf) return [];

    // 1. Get entities for this custom field
    const entities = await this.prisma.custom_field_entities.findMany({
      where: {
        custom_field_id: cf.id,
        entity_type: 'App\\Models\\Contact'
      },
      select: { id: true, entity_id: true }
    });

    if (entities.length === 0) return [];

    const entityIdMap = new Map(entities.map(e => [e.id, e.entity_id]));
    const entityIds = entities.map(e => e.id);

    // 2. Get values for these entities
    const entityValues = await this.prisma.custom_field_entity_values.findMany({
      where: {
        cf_entity_id: { in: entityIds },
        value: { contains: value }
      },
      select: { cf_entity_id: true }
    });

    return entityValues
      .map(ev => entityIdMap.get(ev.cf_entity_id))
      .filter((id): id is bigint => id !== undefined);
  }

  private async getAllContactIds(workspaceId: bigint): Promise<bigint[]> {
    const contacts = await this.prisma.contacts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true }
    });
    return contacts.map(c => c.id);
  }
}
