// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

// Replyagent's `custom_fields_for` enum values — kept aligned with
// prisma/schema.prisma so a bad client payload fails server-side instead of
// hitting a Prisma constraint error.
const FOR_VALUES = ['COMPANY', 'WORKSPACE', 'OPPORTUNITY', 'CONTACT'] as const;
const CONTENT_TYPES = [
  'COUNTRY',
  'CURRENCY',
  'DATE',
  'DATETIME',
  'GENDER',
  'NUMBER',
  'PHONE',
  'TEXT',
  'URL',
  'EMAIL',
  'JSON',
  'FIXED',
] as const;
const INPUT_TYPES = [
  'checkbox',
  'multiselect',
  'radio',
  'select',
  'text',
  'textarea',
  'email',
  'number',
  'paragraph',
] as const;
const LIST_TYPES = ['create', 'import'] as const;

// Laravel-style modelable_type strings — kept exactly as replyagent stores
// them so existing log readers and cross-workspace tooling can identify the
// owner class without translation.
const MODELABLE_TYPES: Record<string, string> = {
  WORKSPACE: 'App\\Models\\Workspace',
  CONTACT: 'App\\Models\\Contact',
  COMPANY: 'App\\Models\\Company',
  OPPORTUNITY: 'App\\Models\\Pipeline\\Opportunity',
};

// Input types that drive a "choices" property list (select/multiselect/etc).
// When `has_properties` flips on we expect the client to send a `properties`
// array; without it the field renders as a free-text input on consumers.
const PROPERTY_BACKED_INPUTS = new Set<string>([
  'checkbox',
  'multiselect',
  'radio',
  'select',
]);

@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger(CustomFieldsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The set of enums + Laravel-style entity classes the frontend needs to
   * populate dropdowns. Single round-trip so we don't drift if the schema
   * ever adds a value.
   */
  getEnums() {
    return {
      content_types: CONTENT_TYPES,
      input_types: INPUT_TYPES,
      list_types: LIST_TYPES,
      for_values: FOR_VALUES,
      property_backed_inputs: Array.from(PROPERTY_BACKED_INPUTS),
    };
  }

  /**
   * Active countries with iso2/phone-code metadata used by the COUNTRY,
   * CURRENCY, and PHONE custom-field flows (CountryPicker + flag list).
   * Mirrors replyagent's `appStore.countries`.
   */
  async getCountries() {
    const rows = await this.prisma.countries.findMany({
      where: { status: 'ACTIVE' as any },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        iso2: true,
        iso3: true,
        phone_code: true,
        phone_digits: true,
        currency: true,
      },
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }

  /**
   * Best-effort audit_logs writer for custom field CRUD. Mirrors replyagent's
   * `AuditLog::log()` semantics — modelable_type is the Laravel namespace
   * path so existing dashboards recognise the entry.
   */
  private async audit(
    workspaceId: bigint,
    userId: bigint | null,
    event: string,
    fieldId: bigint | null,
    data: any,
  ): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event,
          modelable_type: 'App\\Models\\Fields\\CustomField',
          modelable_id: fieldId,
          data: JSON.stringify(data ?? {}),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[custom-fields] audit log failed (${event}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Get Custom Fields for a workspace with various filters
   */
  async getCustomFields(workspaceId: bigint, params: any) {
    const where: any = { workspace_id: workspaceId };

    if (params.content_type) {
      where.content_type = params.content_type;
    }

    const folder_id = params.folder_id;
    if (folder_id === undefined || folder_id === null) {
      where.folder_id = null;
    } else if (folder_id !== 'ALL') {
      where.folder_id = BigInt(folder_id);
    }

    const fieldsRaw = await this.prisma.custom_fields.findMany({
      where,
      orderBy: { created_at: params.order === 'desc' ? 'desc' : 'asc' },
    });

    const fieldIds = fieldsRaw.map((f) => f.id);
    const properties = await this.prisma.custom_field_properties.findMany({
      where: { custom_field_id: { in: fieldIds } },
    });

    const fields = fieldsRaw.map((f) => ({
      ...f,
      custom_field_properties: properties.filter(
        (p) => p.custom_field_id === f.id,
      ),
    }));

    const totalFields = await this.prisma.custom_fields.count({
      where: { workspace_id: workspaceId },
    });

    const folders = await this.prisma.custom_field_folders.findMany({
      where: { workspace_id: workspaceId },
    });

    return {
      success: true,
      total_fields: totalFields,
      fields,
      folders,
    };
  }

  /**
   * Create or update a Custom Field. Mirrors replyagent's
   * `CustomFieldsController@createField`:
   *   - presence of `slug` toggles update mode (lookup by slug, not id)
   *   - on create, `system_name` becomes the slug
   *   - properties are replaced wholesale (delete-then-insert) — this
   *     matches replyagent and is what the Vue form's "save" button posts
   *
   * Server-side enum validation closes the gap where the client could send
   * any string and silently land an invalid row. Length limits mirror the
   * Vue form's `maxlength` attributes so a direct API call can't bypass them.
   */
  async createField(workspaceId: bigint, userId: bigint, data: any) {
    const { label, content_type, input_type, slug, system_name, properties } =
      data;

    if (!label || !content_type || !input_type) {
      throw new BadRequestException('label, content_type and input_type are required');
    }
    if (String(label).length > 60) {
      throw new BadRequestException('label must be 60 characters or fewer');
    }
    if (!(CONTENT_TYPES as readonly string[]).includes(content_type)) {
      throw new BadRequestException(
        `content_type must be one of: ${CONTENT_TYPES.join(', ')}`,
      );
    }
    if (!(INPUT_TYPES as readonly string[]).includes(input_type)) {
      throw new BadRequestException(
        `input_type must be one of: ${INPUT_TYPES.join(', ')}`,
      );
    }
    const listType = data.list_type || 'create';
    if (!(LIST_TYPES as readonly string[]).includes(listType)) {
      throw new BadRequestException(
        `list_type must be one of: ${LIST_TYPES.join(', ')}`,
      );
    }
    const creatingFor = data.creating_for || data.for || 'WORKSPACE';
    if (!(FOR_VALUES as readonly string[]).includes(creatingFor)) {
      throw new BadRequestException(
        `creating_for must be one of: ${FOR_VALUES.join(', ')}`,
      );
    }

    const hasProperties = PROPERTY_BACKED_INPUTS.has(input_type) ? 1 : 0;
    const isMultiselect =
      input_type === 'multiselect' || input_type === 'checkbox' ? 1 : 0;

    let field: any;
    let isUpdate = false;
    if (slug) {
      // Update path — keep `slug` immutable so the public API contract
      // doesn't churn (replyagent's slug is the public identifier).
      field = await this.prisma.custom_fields.findFirst({
        where: { workspace_id: workspaceId, slug: slug },
      });
      if (!field) throw new NotFoundException('Field not found');
      isUpdate = true;

      field = await this.prisma.custom_fields.update({
        where: { id: field.id },
        data: {
          label,
          description: data.description ?? null,
          validation:
            typeof data.validation === 'string'
              ? data.validation
              : data.validation
                ? JSON.stringify(data.validation)
                : null,
          content_type,
          input_type,
          list_type: listType,
          has_properties: hasProperties,
          is_multiselect: isMultiselect,
          fixed_value: data.fixed_value ?? null,
          folder_id: data.folder_id ? BigInt(data.folder_id) : field.folder_id,
          display_inbox:
            data.display_inbox === undefined
              ? field.display_inbox
              : data.display_inbox
                ? 1
                : 0,
          allow_in_feeder:
            data.allow_in_feeder === undefined
              ? field.allow_in_feeder
              : !!data.allow_in_feeder,
        },
      });
    } else {
      if (!system_name)
        throw new BadRequestException('system_name is required');

      // Strip whitespace from the slug — replyagent does the same so the
      // public ID is URL-safe.
      const safeSlug = String(system_name).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9_]+$/.test(safeSlug)) {
        throw new BadRequestException(
          'system_name must be alphanumeric / underscore',
        );
      }
      if (safeSlug.length > 60) {
        throw new BadRequestException('system_name must be 60 characters or fewer');
      }

      const existing = await this.prisma.custom_fields.findFirst({
        where: { workspace_id: workspaceId, slug: safeSlug },
      });
      if (existing) throw new BadRequestException('System name is taken');

      const modelableType = MODELABLE_TYPES[creatingFor] ?? MODELABLE_TYPES.WORKSPACE;
      const modelableId = data.for_id ? BigInt(data.for_id) : workspaceId;

      field = await this.prisma.custom_fields.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          modelable_id: modelableId,
          modelable_type: modelableType,
          for: creatingFor,
          label,
          slug: safeSlug,
          content_type,
          input_type,
          list_type: listType,
          has_properties: hasProperties,
          is_multiselect: isMultiselect,
          description: data.description ?? null,
          validation:
            typeof data.validation === 'string'
              ? data.validation
              : data.validation
                ? JSON.stringify(data.validation)
                : null,
          fixed_value: data.fixed_value ?? null,
          folder_id: data.folder_id ? BigInt(data.folder_id) : null,
          display_inbox: data.display_inbox === false ? 0 : 1,
          allow_in_feeder: !!data.allow_in_feeder,
          is_fixed: content_type === 'FIXED' ? 1 : 0,
        },
      });
    }

    if (Array.isArray(properties)) {
      await this.prisma.custom_field_properties.deleteMany({
        where: { custom_field_id: field.id },
      });
      for (const prop of properties) {
        const name = (prop?.name ?? prop?.label ?? '').toString().trim();
        const value = (prop?.value ?? prop?.id ?? name).toString().trim();
        if (!name) continue;
        await this.prisma.custom_field_properties.create({
          data: { custom_field_id: field.id, name, value },
        });
      }
    }

    const eventName = isUpdate ? 'custom_field.updated' : 'custom_field.created';
    this.events.emit(eventName, {
      workspaceId,
      fieldId: field.id,
      slug: field.slug,
      label: field.label,
      content_type: field.content_type,
      input_type: field.input_type,
    });
    await this.audit(
      workspaceId,
      userId,
      isUpdate ? 'custom_field_updated' : 'custom_field_created',
      field.id,
      {
        slug: field.slug,
        label: field.label,
        content_type: field.content_type,
        input_type: field.input_type,
        for: field.for,
      },
    );

    // Return field WITH its properties so the client can re-render without
    // a second fetch.
    const withProps = await this.prisma.custom_field_properties.findMany({
      where: { custom_field_id: field.id },
    });

    return {
      success: true,
      field: { ...field, custom_field_properties: withProps },
    };
  }

  /**
   * Delete Custom Field — cascades to properties + entity values + entity
   * rows so a re-created field with the same slug never inherits stale
   * data. Emits `custom_field.deleted`; audit logged as
   * `custom_field_deleted`.
   */
  async deleteCustomField(
    workspaceId: bigint,
    userId: bigint | null,
    slug: string,
  ) {
    const field = await this.prisma.custom_fields.findFirst({
      where: { workspace_id: workspaceId, slug: slug },
    });
    if (!field) throw new NotFoundException('Field not found');

    // Cascade: properties → entity rows → entity values. Order matters so
    // we don't orphan the value rows behind the entities.
    const entities = await this.prisma.custom_field_entities.findMany({
      where: { custom_field_id: field.id },
      select: { id: true },
    });
    const entityIds = entities.map((e) => e.id);
    if (entityIds.length) {
      await this.prisma.custom_field_entity_values
        .deleteMany({ where: { cf_entity_id: { in: entityIds } } })
        .catch(() => undefined);
      await this.prisma.custom_field_entities
        .deleteMany({ where: { id: { in: entityIds } } })
        .catch(() => undefined);
    }
    await this.prisma.custom_field_properties.deleteMany({
      where: { custom_field_id: field.id },
    });
    await this.prisma.custom_fields.delete({ where: { id: field.id } });

    this.events.emit('custom_field.deleted', {
      workspaceId,
      fieldId: field.id,
      slug,
    });
    await this.audit(workspaceId, userId, 'custom_field_deleted', field.id, {
      slug,
      label: field.label,
    });

    return { success: true, slug };
  }

  /**
   * Remove a single property
   */
  async removeProperty(workspaceId: bigint, propertyName: string) {
    const property = await this.prisma.custom_field_properties.findFirst({
      where: { name: propertyName },
    });

    if (!property) throw new NotFoundException('Property not found');

    const field = await this.prisma.custom_fields.findFirst({
      where: { id: property.custom_field_id },
    });

    if (!field || field.workspace_id !== workspaceId) {
      throw new NotFoundException('Property not found');
    }

    await this.prisma.custom_field_properties.delete({
      where: { id: property.id },
    });

    return { success: true };
  }

  /**
   * Slug availability check
   */
  async checkNameAvailability(workspaceId: bigint, systemName: string) {
    const name = systemName.replace(/\s+/g, '');
    if (!name) return { is_available: false };

    const exists = await this.prisma.custom_fields.findFirst({
      where: { workspace_id: workspaceId, slug: name },
    });

    return { is_available: !exists };
  }

  /**
   * Toggle Feeder. Emits `custom_field.updated` so AI feeders that listen
   * for visibility changes can react. Audit-logged.
   */
  async toggleFeeder(workspaceId: bigint, userId: bigint | null, fieldId: bigint) {
    const field = await this.prisma.custom_fields.findFirst({
      where: { id: fieldId, workspace_id: workspaceId },
    });
    if (!field) throw new NotFoundException('Field not found');

    const updated = await this.prisma.custom_fields.update({
      where: { id: fieldId },
      data: { allow_in_feeder: !field.allow_in_feeder },
    });

    this.events.emit('custom_field.updated', {
      workspaceId,
      fieldId,
      slug: updated.slug,
      allow_in_feeder: updated.allow_in_feeder,
    });
    await this.audit(workspaceId, userId, 'custom_field_feeder_toggled', fieldId, {
      slug: updated.slug,
      allow_in_feeder: updated.allow_in_feeder,
    });

    return { success: true, allow_in_feeder: updated.allow_in_feeder };
  }

  // ─── Folder Management ──────────────────────────────────────────────

  async getFolders(workspaceId: bigint) {
    return this.prisma.custom_field_folders.findMany({
      where: { workspace_id: workspaceId },
    });
  }

  async createFolder(workspaceId: bigint, data: any) {
    if (data.id) {
      const folder = await this.prisma.custom_field_folders.findFirst({
        where: { id: BigInt(data.id), workspace_id: workspaceId },
      });
      if (!folder) throw new NotFoundException('Folder not found');

      return this.prisma.custom_field_folders.update({
        where: { id: folder.id },
        data: { name: data.name },
      });
    }

    return this.prisma.custom_field_folders.create({
      data: {
        workspace_id: workspaceId,
        name: data.name,
      },
    });
  }

  async changeFolder(
    workspaceId: bigint,
    fieldId: bigint,
    folderId: bigint | null,
  ) {
    const field = await this.prisma.custom_fields.findFirst({
      where: { id: fieldId, workspace_id: workspaceId },
    });
    if (!field) throw new NotFoundException('Field not found');

    if (folderId) {
      const folder = await this.prisma.custom_field_folders.findFirst({
        where: { id: folderId, workspace_id: workspaceId },
      });
      if (!folder) throw new NotFoundException('Folder not found');
    }

    return this.prisma.custom_fields.update({
      where: { id: fieldId },
      data: { folder_id: folderId },
    });
  }

  async deleteFolder(workspaceId: bigint, folderId: bigint) {
    const folder = await this.prisma.custom_field_folders.findFirst({
      where: { id: folderId, workspace_id: workspaceId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const hasFields = await this.prisma.custom_fields.count({
      where: { folder_id: folderId },
    });
    if (hasFields > 0) throw new BadRequestException('Folder is not empty');

    await this.prisma.custom_field_folders.delete({
      where: { id: folderId },
    });

    return { success: true };
  }

  // ─── Value Management ──────────────────────────────────────────────

  async getEntityValues(entityType: string, entityId: bigint) {
    const entities = await this.prisma.custom_field_entities.findMany({
      where: { entity_type: entityType, entity_id: entityId },
      include: {
        custom_fields: true,
        custom_field_entity_values: true,
      },
    });

    return entities.map((e) => ({
      id: e.custom_field_id,
      label: e.custom_fields?.label,
      slug: e.custom_fields?.slug,
      value: e.custom_field_entity_values[0]?.value,
    }));
  }

  async upsertFieldValue(
    entityType: string,
    entityId: bigint,
    fieldId: bigint,
    value: string,
  ) {
    // 1. Ensure entity record exists
    let entity = await this.prisma.custom_field_entities.findFirst({
      where: {
        entity_type: entityType,
        entity_id: entityId,
        custom_field_id: fieldId,
      },
    });

    if (!entity) {
      entity = await this.prisma.custom_field_entities.create({
        data: {
          entity_type: entityType,
          entity_id: entityId,
          custom_field_id: fieldId,
        },
      });
    }

    // 2. Upsert Value
    const existingValue = await this.prisma.custom_field_entity_values.findFirst({
      where: { cf_entity_id: entity.id },
    });

    if (existingValue) {
      return this.prisma.custom_field_entity_values.update({
        where: { id: existingValue.id },
        data: { value: String(value) },
      });
    } else {
      return this.prisma.custom_field_entity_values.create({
        data: {
          cf_entity_id: entity.id,
          value: String(value),
        },
      });
    }
  }
}

