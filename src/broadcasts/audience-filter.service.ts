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
      case 'mobile_number':
        contactIds = await this.filterMobileModule(workspaceId, key, filterType, value);
        break;
      case 'email':
        contactIds = await this.filterEmailModule(workspaceId, filterType, value);
        break;
      default:
        // Not implemented yet (opportunity, per-channel attributes…).
        // Matching nobody is the safe default — see filterContactModule.
        this.logger.warn(`executeSingleFilter: unsupported module "${module}" — matching no contacts`);
    }

    return new Set(contactIds);
  }

  /**
   * Prisma condition for the composer's text operators. `undefined` means the
   * operator isn't supported — callers must then match NOBODY rather than fall
   * through with an unfiltered query.
   */
  private stringWhere(op: string, value: any): any | undefined {
    const v = value == null ? '' : String(value);
    switch (op) {
      case 'is': return v;
      case 'is_not': return { not: v };
      // 'contain' is the older spelling still stored on existing broadcasts.
      case 'contains': case 'contain': return { contains: v };
      case 'does_not_contain': return { not: { contains: v } };
      case 'begins_with': return { startsWith: v };
      case 'has_value': return { not: null };
      case 'is_null': return null;
      default: return undefined;
    }
  }

  private dateWhere(op: string, value: any): any | undefined {
    const d = value ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) return undefined;
    switch (op) {
      case 'before': return { lt: d };
      case 'after': return { gt: d };
      case 'is': {
        // "is <date>" means anywhere in that calendar day.
        const start = new Date(d); start.setHours(0, 0, 0, 0);
        const end = new Date(d); end.setHours(23, 59, 59, 999);
        return { gte: start, lte: end };
      }
      default: return undefined;
    }
  }

  /**
   * contact_mobiles / contact_emails carry no workspace_id, so ids matched
   * there must be narrowed to this workspace's live contacts before use.
   */
  private async scopeToWorkspace(workspaceId: bigint, ids: bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.contacts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null, id: { in: ids } },
      select: { id: true },
    });
    return rows.map(c => c.id);
  }

  private async filterContactModule(workspaceId: bigint, key: string, filterType: string, value: any): Promise<bigint[]> {
    const where: any = { workspace_id: workspaceId, deleted_at: null };
    let condition: any;

    if (key === 'full_name' || key === 'first_name' || key === 'last_name' || key === 'title') {
      condition = this.stringWhere(filterType, value);
    } else if (key === 'source') {
      // Enum column (MANUAL / IMPORT / WHATSAPP / …) — only exact match applies.
      const v = String(value ?? '').trim().toUpperCase();
      if (filterType === 'is') condition = v;
      else if (filterType === 'is_not') condition = { not: v };
    } else if (key === 'id') {
      let id: bigint;
      try {
        id = BigInt(String(value ?? '').trim());
      } catch {
        this.logger.warn(`filterContactModule: contact id "${value}" isn't numeric — matching no contacts`);
        return [];
      }
      if (filterType === 'is') condition = id;
      else if (filterType === 'is_not') condition = { not: id };
      else if (filterType === 'greater_than') condition = { gt: id };
      else if (filterType === 'less_than') condition = { lt: id };
    } else if (key === 'created_at') {
      condition = this.dateWhere(filterType, value);
    } else {
      // Unknown key must match NOBODY: an unfiltered `where` would silently
      // return every contact in the workspace and blast the broadcast to all.
      this.logger.warn(`filterContactModule: unsupported key "${key}" — matching no contacts`);
      return [];
    }

    if (condition === undefined) {
      this.logger.warn(`filterContactModule: unsupported operator "${filterType}" on "${key}" — matching no contacts`);
      return [];
    }
    where[key] = condition;

    const contacts = await this.prisma.contacts.findMany({ where, select: { id: true } });
    return contacts.map(c => c.id);
  }

  /**
   * Phone / WhatsApp number / country code — all live on contact_mobiles.
   *
   * `phone` and `whatsapp_number` deliberately behave the same: the `type`
   * column is not trustworthy (real data has 'mobile', 'whatsapp' and NULL for
   * what is the same WhatsApp number, depending on how the contact was
   * created), so filtering by it would silently match nobody. Each contact
   * holds one number here anyway.
   *
   * The number is stored both with the country code (`+923335725333`) and
   * without (`923335725333`) — and inconsistently, some rows keep the `+` in
   * the national column too — so both columns are tried. "contains" is the
   * practical operator; "is" demands the exact stored form.
   */
  private async filterMobileModule(workspaceId: bigint, key: string, filterType: string, value: any): Promise<bigint[]> {
    const where: any = { modelable_type: 'App\\Models\\Contact' };

    if (key === 'phone_country_code') {
      const condition = this.stringWhere(filterType, String(value ?? '').replace(/^\+/, ''));
      if (condition === undefined) {
        this.logger.warn(`filterMobileModule: unsupported operator "${filterType}" — matching no contacts`);
        return [];
      }
      where.country_code = condition;
    } else if (key === 'phone' || key === 'whatsapp_number') {
      const condition = this.stringWhere(filterType, value);
      if (condition === undefined) {
        this.logger.warn(`filterMobileModule: unsupported operator "${filterType}" — matching no contacts`);
        return [];
      }
      where.OR = [{ full_mobile_number: condition }, { national_mobile_number: condition }];
    } else {
      this.logger.warn(`filterMobileModule: unsupported key "${key}" — matching no contacts`);
      return [];
    }

    const rows = await this.prisma.contact_mobiles.findMany({
      where,
      select: { modelable_id: true },
    });
    return this.scopeToWorkspace(workspaceId, rows.map(r => r.modelable_id));
  }

  private async filterEmailModule(workspaceId: bigint, filterType: string, value: any): Promise<bigint[]> {
    const condition = this.stringWhere(filterType, value);
    if (condition === undefined) {
      this.logger.warn(`filterEmailModule: unsupported operator "${filterType}" — matching no contacts`);
      return [];
    }
    const rows = await this.prisma.contact_emails.findMany({
      where: { modelable_type: 'App\\Models\\Contact', email: condition },
      select: { modelable_id: true },
    });
    return this.scopeToWorkspace(workspaceId, rows.map(r => r.modelable_id));
  }

  private async filterTagModule(workspaceId: bigint, key: string, filterType: string, value: any): Promise<bigint[]> {
    // value is usually { name: 'Tag Name' } or { id: 'Tag ID' }
    const tagName = typeof value === 'string' ? value : value?.name;
    if (!tagName) {
      this.logger.warn('filterTagModule: no tag name given — matching no contacts');
      return [];
    }
    const tagLinks = await this.prisma.tag_links.findMany({
      where: {
        name: tagName,
        linkable_type: 'App\\Models\\Contact'
      },
      select: { linkable_id: true }
    });
    // tag_links has no workspace_id, so a same-named tag in another workspace
    // would otherwise pull in that workspace's contacts.
    const tagged = await this.scopeToWorkspace(workspaceId, tagLinks.map(tl => tl.linkable_id));
    if (filterType !== 'is_not') return tagged;

    // "is not" → everyone in the workspace except the tagged contacts.
    const all = await this.getAllContactIds(workspaceId);
    const taggedSet = new Set(tagged.map(id => id.toString()));
    return all.filter(id => !taggedSet.has(id.toString()));
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
    const condition = this.stringWhere(filterType, value);
    if (condition === undefined) {
      this.logger.warn(`filterCustomFieldModule: unsupported operator "${filterType}" — matching no contacts`);
      return [];
    }
    const entityValues = await this.prisma.custom_field_entity_values.findMany({
      where: {
        cf_entity_id: { in: entityIds },
        value: condition,
      },
      select: { cf_entity_id: true }
    });

    const ids = entityValues
      .map(ev => entityIdMap.get(ev.cf_entity_id))
      .filter((id): id is bigint => id !== undefined);
    // custom_field_entities isn't workspace-scoped on its own.
    return this.scopeToWorkspace(workspaceId, ids);
  }

  private async getAllContactIds(workspaceId: bigint): Promise<bigint[]> {
    const contacts = await this.prisma.contacts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true }
    });
    return contacts.map(c => c.id);
  }
}
