// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customFieldsService: CustomFieldsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Get contacts with workspace scoping and basic filters
   */
  async getContacts(workspaceId: bigint, query: any) {
    const { search, status, tag_id } = query;
    const where: any = {
      workspace_id: workspaceId,
      deleted_at: null,
    };

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { first_name: { contains: search } },
        { last_name: { contains: search } },
        { full_name: { contains: search } },
      ];
    }

    if (tag_id) {
      where.tag_links = {
        some: { tag_id: BigInt(tag_id) },
      };
    }

    const contacts = await this.prisma.contacts.findMany({
      where,
      orderBy: { id: 'desc' },
      take: 50, // Default pagination limit for now
    });

    // Fetch tags manually to avoid Prisma relation errors
    const contactIds = contacts.map(c => c.id);
    const tagLinks = contactIds.length > 0 ? await this.prisma.tag_links.findMany({
      where: {
        linkable_type: 'App\\Models\\Contact',
        linkable_id: { in: contactIds }
      }
    }) : [];

    // Attach tag_links to contacts in the format the frontend expects
    const contactsWithTags = contacts.map(contact => {
      const contactTags = tagLinks.filter(tl => tl.linkable_id === contact.id);
      return {
        ...contact,
        tag_links: contactTags.map(tl => ({ tags: { name: tl.name } }))
      };
    });

    return { success: true, contacts: contactsWithTags };
  }

  /**
   * Get single contact detail
   */
  /**
   * Single contact detail — fully enriched for the ContactDetailsModal:
   *   - tag_links (was referencing an undefined var; fixed)
   *   - phones (contact_mobiles, sorted primary first, type whatsapp/phone split)
   *   - emails (contact_emails, primary first)
   *   - custom_fields (via CustomFieldsService)
   *   - linked-record counts (tasks / bookings / calls / ad_clicks) so the
   *     left sidebar can render real numbers instead of zeros
   */
  async getContact(workspaceId: bigint, contactId: bigint) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    // Tag links — proper per-contact query (previous code referenced a var
    // from getContacts() and crashed at runtime).
    const tagLinks = await this.prisma.tag_links.findMany({
      where: {
        linkable_type: 'App\\Models\\Contact',
        linkable_id: contact.id,
      },
    });

    // Phones / emails. We split phones into the WhatsApp variant + the
    // regular `phone` rows so the modal can render them as separate sections
    // (matches the screenshot).
    const [allMobiles, emails] = await Promise.all([
      this.prisma.contact_mobiles.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: contact.id,
        },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.contact_emails.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: contact.id,
        },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }),
    ]);

    const phones = allMobiles
      .filter((m) => String(m.type ?? 'phone').toLowerCase() !== 'whatsapp')
      .map((m) => this.serializeMobile(m));
    const whatsapps = allMobiles
      .filter((m) => String(m.type ?? '').toLowerCase() === 'whatsapp')
      .map((m) => this.serializeMobile(m));

    // Linked-record counts powering the sidebar TASKS / BOOKINGS / CALLS /
    // AD CLICKS chips. Each lookup is best-effort: a missing table or a
    // mismatched modelable shape yields 0 rather than crashing the whole
    // detail fetch.
    const tasksCount = await this.prisma.tasks
      .count({ where: { workspace_id: workspaceId, contact_id: contact.id } })
      .catch(() => 0);
    const bookingsCount = await this.prisma.bookings
      .count({ where: { workspace_id: workspaceId, contact_id: contact.id } })
      .catch(() => 0);

    // Calls: twilio_call_logs scoped to the workspace's twilio accounts, then
    // matched to any of the contact's mobile numbers (from / to). If the
    // contact has no numbers we skip the lookup entirely.
    let callsCount = 0;
    const allNumbers = allMobiles
      .map((m) => m.full_mobile_number ?? m.mobile_number ?? null)
      .filter((x): x is string => !!x);
    if (allNumbers.length) {
      try {
        const twilioAccountIds = (
          await this.prisma.twilio_accounts.findMany({
            where: { workspace_id: workspaceId, deleted_at: null },
            select: { id: true },
          })
        ).map((a) => a.id);
        if (twilioAccountIds.length) {
          callsCount = await this.prisma.twilio_call_logs.count({
            where: {
              twilio_account_id: { in: twilioAccountIds },
              OR: [
                { from_number: { in: allNumbers } },
                { to_number: { in: allNumbers } },
              ],
            },
          });
        }
      } catch {
        callsCount = 0;
      }
    }

    const customFields = await this.customFieldsService
      .getEntityValues('Contact', contact.id)
      .catch(() => [] as any[]);

    // ─── Linked-record LISTS (not just counts) ──────────────────────
    // The contact-details modal needs to render the actual task rows,
    // booking rows, call rows etc. in the left sidebar. We cap at 5 each
    // for the sidebar preview; the "see all" affordance can paginate later.

    const tasks = await this.prisma.tasks
      .findMany({
        where: { workspace_id: workspaceId, contact_id: contact.id },
        orderBy: [{ datetime: 'desc' }, { id: 'desc' }],
        take: 5,
      })
      .catch(() => [] as any[]);
    const taskUserIds = Array.from(
      new Set(tasks.map((t) => t.user_id).filter((x): x is bigint => !!x)),
    );
    const taskUsers = taskUserIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: taskUserIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const taskUserById = new Map(taskUsers.map((u) => [u.id.toString(), u]));

    const bookings = await this.prisma.bookings
      .findMany({
        where: { workspace_id: workspaceId, contact_id: contact.id },
        orderBy: [{ start: 'desc' }, { id: 'desc' }],
        take: 5,
      })
      .catch(() => [] as any[]);

    // Latest open Support-Number-Task entry for this inbox (replyagent
    // surfaces this as a top-of-profile chip).
    let supportNumberTask: string | null = null;
    try {
      const sn = await this.prisma.support_numbers.findFirst({
        where: { workspace_id: workspaceId, contact_id: contact.id, is_open: 1 },
        orderBy: { id: 'desc' },
        select: { sn_number: true },
      });
      supportNumberTask = sn?.sn_number ?? null;
    } catch {}

    return {
      success: true,
      contact: {
        ...this.serialize(contact),
        tag_links: tagLinks.map((tl) => ({ tags: { name: tl.name } })),
        tags: tagLinks.map((tl) => tl.name),
        phones,
        whatsapps,
        emails: emails.map((e) => ({
          id: e.id.toString(),
          email: e.email,
          type: e.type,
          is_primary: !!e.is_primary,
          created_at: e.created_at,
        })),
        custom_fields: customFields,
        support_number_task: supportNumberTask,
        tasks: tasks.map((t) => {
          const u = t.user_id ? taskUserById.get(t.user_id.toString()) : null;
          const assigneeName = u
            ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || `User ${u.id}`
            : null;
          return {
            id: t.id.toString(),
            description: t.description,
            datetime: t.datetime,
            status: t.status,
            assignee_name: assigneeName,
            assignee_initials: assigneeName
              ? assigneeName
                  .split(/\s+/)
                  .map((p: string) => p[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()
              : null,
          };
        }),
        bookings: bookings.map((b) => ({
          id: b.id.toString(),
          title: b.eventTitle ?? b.booking_id ?? `Booking ${b.id}`,
          start: b.start,
          booking_id: b.booking_id,
        })),
        counts: {
          tasks: tasksCount,
          bookings: bookingsCount,
          calls: callsCount,
          ad_clicks: 0, // ad_clicks table not present yet — keep slot for parity
          opportunities: 0,
          groups: 0,
        },
      },
    };
  }

  /** Project a contact_mobiles row into the lean shape the modal renders. */
  private serializeMobile(m: any) {
    return {
      id: m.id.toString(),
      country_code: m.country_code ?? null,
      mobile_number: m.mobile_number ?? null,
      full_mobile_number: m.full_mobile_number ?? null,
      type: m.type ?? 'phone',
      is_primary: !!m.is_primary,
      created_at: m.created_at,
    };
  }

  /**
   * Check if contact already exists by email or phone in workspace
   */
  async findExistingContact(workspaceId: bigint, email?: string, phone?: string) {
    if (email) {
      const emailRecord = await this.prisma.contact_emails.findFirst({
        where: { email, modelable_type: 'App\\Models\\Contact' },
        include: { contacts: true } // Assuming relation exists
      });
      // Since relations might be missing, we query contacts table manually
      if (emailRecord) {
        const contact = await this.prisma.contacts.findFirst({
          where: { id: emailRecord.modelable_id, workspace_id: workspaceId, deleted_at: null }
        });
        if (contact) return contact;
      }
    }

    if (phone) {
      const mobileRecord = await this.prisma.contact_mobiles.findFirst({
        where: { full_mobile_number: phone, modelable_type: 'App\\Models\\Contact' }
      });
      if (mobileRecord) {
        const contact = await this.prisma.contacts.findFirst({
          where: { id: mobileRecord.modelable_id, workspace_id: workspaceId, deleted_at: null }
        });
        if (contact) return contact;
      }
    }

    return null;
  }

  /**
   * Helper to sync tags for a contact
   */
  private async syncTags(workspaceId: bigint, contactId: bigint, tagNames: string[]) {
    // 1. Capture-then-remove so we can emit tag_removed for each detached tag.
    //    Skipping this would silently miss every `tag_removed` automation trigger.
    const existingLinks = await this.prisma.tag_links.findMany({
      where: {
        linkable_type: 'App\\Models\\Contact',
        linkable_id: contactId,
      },
      select: { tag_id: true },
    });
    await this.prisma.tag_links.deleteMany({
      where: {
        linkable_type: 'App\\Models\\Contact',
        linkable_id: contactId
      }
    });
    for (const link of existingLinks) {
      this.eventEmitter.emit('contact.tag_removed', {
        contactId,
        tagId: link.tag_id,
        workspaceId,
      });
    }

    if (!tagNames || tagNames.length === 0) return;

    // 2. Find or create tags by name
    for (const tagName of tagNames) {
      let tag = await this.prisma.tags.findFirst({
        where: { workspace_id: workspaceId, name: tagName }
      });
      
      if (!tag) {
        // Find an admin user to assign as creator, or use a default
        const adminUser = await this.prisma.users.findFirst({
          where: { workspace_id: workspaceId }
        });
        tag = await this.prisma.tags.create({
          data: {
            workspace_id: workspaceId,
            user_id: adminUser ? adminUser.id : BigInt(1),
            taggable_type: 'App\\Models\\Workspace',
            taggable_id: workspaceId,
            name: tagName,
            display_inbox: 0,
            bg_color: '#d3c78d',
            text_color: '#c04d30'
          }
        });
      }

      // 3. Create tag link
      await this.prisma.tag_links.create({
        data: {
          linkable_type: 'App\\Models\\Contact',
          linkable_id: contactId,
          tag_id: tag.id,
          name: tag.name
        }
      });

      // Emit event for automation
      this.eventEmitter.emit('contact.tag_applied', {
        contactId,
        tagId: tag.id,
        workspaceId
      });
    }
  }

  /**
   * Enforce the workspace's contacts cap — replyagent parity.
   * Only blocks when `limited_contacts` is on AND active count >= maximum_contacts.
   * Called before any NEW contact insert (single add + CSV import). Throws so the
   * upstream controller bubbles a 400 to the UI as a toast.
   */
  private async enforceContactsLimit(workspaceId: bigint): Promise<void> {
    const ws = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { limited_contacts: true, maximum_contacts: true },
    });
    if (!ws?.limited_contacts) return;
    const max = Number(ws.maximum_contacts ?? 0);
    if (max <= 0) return;
    // EZCONN soft-deletes contacts via `deleted_at` (deleteContact above:413-417),
    // not via the contacts_status enum. Excluding deleted rows keeps freed slots
    // available for new contacts — same intent as replyagent's billing checks.
    const current = await this.prisma.contacts.count({
      where: {
        workspace_id: workspaceId,
        deleted_at: null,
      },
    });
    if (current >= max) {
      throw new BadRequestException('Reached the limit');
    }
  }

  /**
   * Add or Update a contact
   */
  async addContact(workspaceId: bigint, data: any, existingId?: bigint) {
    const {
      first_name,
      last_name,
      title,
      gender,
      language,
      timezone,
      company_id,
      tags
    } = data;

    if (!first_name && !last_name && !title) {
      throw new BadRequestException(
        'At least one of First Name, Last Name, or Title is required',
      );
    }

    const fullName = `${first_name || ''} ${last_name || ''}`.trim();

    const payload: any = {
      first_name,
      last_name,
      full_name: fullName,
      title,
      gender,
      language,
      timezone,
      company_id: company_id ? BigInt(company_id) : undefined,
    };

    let contact;
    if (existingId) {
      contact = await this.prisma.contacts.update({
        where: { id: existingId },
        data: payload,
      });
    } else {
      // Identity Check — reuse existing contact if email/phone already exists.
      // The limit only blocks NEW contacts, so this must come BEFORE enforceContactsLimit.
      const existing = await this.findExistingContact(workspaceId, data.email, data.phone);
      if (existing) return await this.getContact(workspaceId, existing.id);

      await this.enforceContactsLimit(workspaceId);

      contact = await this.prisma.contacts.create({
        data: {
          ...payload,
          workspace_id: workspaceId,
          source: 'MANUAL',
          status: 'PENDING',
        },
      });

      // Save Email/Mobile
      if (data.email) {
        await this.prisma.contact_emails.create({
          data: {
            ownership_id: workspaceId,
            ownership_type: 'App\\Models\\Workspace',
            modelable_id: contact.id,
            modelable_type: 'App\\Models\\Contact',
            email: data.email,
            is_primary: 1
          }
        });
      }
      if (data.phone) {
        await this.prisma.contact_mobiles.create({
          data: {
            ownership_id: workspaceId,
            ownership_type: 'App\\Models\\Workspace',
            modelable_id: contact.id,
            modelable_type: 'App\\Models\\Contact',
            full_mobile_number: data.phone,
            country_id: BigInt(data.country_id || 1),
            is_primary: 1
          }
        });
      }
    }

    if (tags && Array.isArray(tags)) {
      await this.syncTags(workspaceId, contact.id, tags);
    }

    // Handle Custom Fields in data
    if (data.custom_fields && typeof data.custom_fields === 'object') {
      for (const [slug, value] of Object.entries(data.custom_fields)) {
        const field = await this.prisma.custom_fields.findFirst({
          where: { workspace_id: workspaceId, slug: slug }
        });
        if (field) {
          await this.customFieldsService.upsertFieldValue('Contact', contact.id, field.id, String(value));
        }
      }
    }

    // Fire the contact.created event so AutomationTriggerService can match any
    // `contact_added` trigger activities. Per replyagent parity this fires
    // exactly once, after the contact + mobiles + emails + tags + custom fields
    // are all persisted (avoids partial-state races during automation execution).
    this.eventEmitter.emit('contact.created', {
      contactId: contact.id,
      workspaceId,
      source: 'MANUAL',
    });

    return await this.getContact(workspaceId, contact.id);
  }

  /**
   * Update specific contact data (System or Custom fields, or Bulk edit)
   */
  async updateContactData(workspaceId: bigint, contactId: bigint, data: any) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId },
    });

    if (!contact) throw new NotFoundException('Contact not found');

    // Handle field/field_type style update (from contact details page)
    if (data.field && data.field_type) {
      const { field, field_type } = data;
      if (field_type === 'SYSTEM_FIELD') {
        const updatePayload = {};
        updatePayload[field.slug] = field.value;
        await this.prisma.contacts.update({
          where: { id: contactId },
          data: updatePayload,
        });
        // Trigger emission: any `system_field_changed` automation can react.
        // We also flag the special date-field case so `date_field_changed`
        // listeners fire too (replyagent parity — date-field triggers are a
        // distinct event so flows can schedule on them).
        this.eventEmitter.emit('contact.system_field_changed', {
          contactId,
          field: field.slug,
          value: field.value,
          workspaceId,
        });
        if (this.isLikelyDateField(field?.slug, field?.value)) {
          this.eventEmitter.emit('contact.date_field_changed', {
            contactId,
            field: field.slug,
            value: field.value,
            workspaceId,
          });
        }
      } else if (field_type === 'CUSTOM_FIELD') {
        const cf = await this.prisma.custom_fields.findFirst({
          where: { workspace_id: workspaceId, slug: field.slug }
        });
        if (cf) {
          await this.customFieldsService.upsertFieldValue('Contact', contactId, cf.id, String(field.value));
          this.eventEmitter.emit('contact.custom_field_changed', {
            contactId,
            fieldId: cf.id,
            value: field.value,
            workspaceId,
          });
          if (this.isCustomDateField(cf)) {
            this.eventEmitter.emit('contact.date_field_changed', {
              contactId,
              field: cf.slug,
              value: field.value,
              workspaceId,
            });
          }
        }
      }
    }
    // Handle direct object update (from edit modal or bulk edit)
    else {
      const payload: any = {};
      if (data.first_name !== undefined) payload.first_name = data.first_name;
      if (data.last_name !== undefined) payload.last_name = data.last_name;
      if (data.first_name !== undefined || data.last_name !== undefined) {
         payload.full_name = `${data.first_name || contact.first_name || ''} ${data.last_name || contact.last_name || ''}`.trim();
      }
      if (data.title !== undefined) payload.title = data.title;

      if (Object.keys(payload).length > 0) {
        await this.prisma.contacts.update({
          where: { id: contactId },
          data: payload
        });
        // Fire one emission per touched system column so individual
        // triggers (system_field_changed with `field` filter) can react.
        for (const k of Object.keys(payload)) {
          this.eventEmitter.emit('contact.system_field_changed', {
            contactId,
            field: k,
            value: payload[k],
            workspaceId,
          });
        }
      }

      if (data.tags && Array.isArray(data.tags)) {
        await this.syncTags(workspaceId, contactId, data.tags);
      }

      if (data.custom_fields && typeof data.custom_fields === 'object') {
        for (const [slug, value] of Object.entries(data.custom_fields)) {
          const cf = await this.prisma.custom_fields.findFirst({
            where: { workspace_id: workspaceId, slug: slug }
          });
          if (cf) {
            await this.customFieldsService.upsertFieldValue('Contact', contactId, cf.id, String(value));
            this.eventEmitter.emit('contact.custom_field_changed', {
              contactId,
              fieldId: cf.id,
              value,
              workspaceId,
            });
            if (this.isCustomDateField(cf)) {
              this.eventEmitter.emit('contact.date_field_changed', {
                contactId,
                field: cf.slug,
                value,
                workspaceId,
              });
            }
          }
        }
      }
    }

    return await this.getContact(workspaceId, contactId);
  }

  /**
   * Coarse heuristic — system fields whose slug looks like a date column,
   * OR whose stored value already parses as an ISO date string. Used to
   * decide whether to fire `contact.date_field_changed` alongside the
   * normal system_field_changed emission.
   */
  private isLikelyDateField(slug: string | undefined, value: any): boolean {
    if (!slug) return false;
    if (/(date|birth|anniversary|expires|expiry|due|scheduled)/i.test(slug)) return true;
    if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}/.test(value)) return true;
    return false;
  }

  /**
   * Whether a custom_fields row represents a date input. Mirrors the
   * `content_type` / `input_type` enums set when a workspace owner creates
   * a date-typed custom field.
   */
  private isCustomDateField(cf: any): boolean {
    const inputType = String(cf?.input_type ?? '').toLowerCase();
    const contentType = String(cf?.content_type ?? '').toLowerCase();
    return inputType.includes('date') || contentType.includes('date');
  }

  private serialize(obj: any) {
    return JSON.parse(
      JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }

  /**
   * Pause flows/automations for a contact
   */
  async pauseAutomations(
    workspaceId: bigint,
    contactId: bigint,
    minutes: number,
  ) {
    const pausedTill = new Date();
    pausedTill.setMinutes(pausedTill.getMinutes() + minutes);

    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { automations_paused_till: pausedTill },
    });

    return { success: true, paused_till: pausedTill };
  }

  /**
   * Delete/Trash a contact
   */
  async deleteContact(workspaceId: bigint, contactId: bigint) {
    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { deleted_at: new Date() },
    });

    return { success: true };
  }

  // ─── Replyagent parity: profile modal endpoints ─────────────────────

  /**
   * Change a contact's status (active / inactive). Mirrors replyagent's
   * POST /contact/change-status/:id { action: status } endpoint.
   */
  async changeContactStatus(
    workspaceId: bigint,
    contactId: bigint,
    status: string,
  ) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const next = String(status || '').toUpperCase();
    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { status: next as any },
    });

    this.eventEmitter.emit('contact.status_changed', {
      contactId,
      workspaceId,
      status: next,
    });

    return { success: true, status: next };
  }

  /**
   * Remove a system field (phone / email / address / url) or a custom field
   * value from a contact. Body shape: { contact, field, type }
   *   - type === 'contact'    → contact_mobiles / contact_emails row
   *   - type === 'additional' → addresses / urls row
   *   - type === 'custom'     → custom field entity value
   */
  async removeField(
    workspaceId: bigint,
    contactId: bigint,
    field: any,
    type: string,
  ) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const slug = String(field?.slug ?? '').toLowerCase();
    const objectId = field?.object_id ? BigInt(field.object_id) : null;

    if (!objectId) {
      return { success: false, message: 'Missing field reference' };
    }

    try {
      if (type === 'contact' || type === 'additional') {
        if (slug === 'mobile' || slug === 'whatsapp') {
          await this.prisma.contact_mobiles.deleteMany({
            where: {
              id: objectId,
              modelable_type: 'App\\Models\\Contact',
              modelable_id: contactId,
            },
          });
        } else if (slug === 'email') {
          await this.prisma.contact_emails.deleteMany({
            where: {
              id: objectId,
              modelable_type: 'App\\Models\\Contact',
              modelable_id: contactId,
            },
          });
        } else if (slug === 'address') {
          // `addresses` is polymorphic via addressable_type/addressable_id.
          await this.prisma.addresses
            .deleteMany({
              where: {
                id: objectId,
                addressable_type: 'App\\Models\\Contact',
                addressable_id: contactId,
              },
            })
            .catch(() => null);
        }
      } else if (type === 'custom') {
        // `custom_field_entity_values` is polymorphic via modelable_type/id;
        // it does NOT carry a `custom_field_id` column directly. `cf_entity_id`
        // is the FK to `custom_field_entities` (junction), so we scope by
        // (cf_entity_id, modelable_type, modelable_id) for safety.
        try {
          await this.prisma.custom_field_entity_values.deleteMany({
            where: {
              cf_entity_id: objectId,
              modelable_type: 'App\\Models\\Contact',
              modelable_id: contactId,
            },
          });
        } catch {}
      }
    } catch (e) {
      this.logger.warn(`removeField failed: ${e}`);
    }

    return await this.getContact(workspaceId, contactId);
  }

  /**
   * Toggle a phone / email row's primary flag. The frontend sends this on
   * the "Mark primary" menu action — replyagent stores a single primary per
   * channel, so flipping one to primary clears the rest of the same type.
   */
  async setPrimary(
    workspaceId: bigint,
    contactId: bigint,
    fieldId: bigint,
    fieldType: 'mobile' | 'email',
    markPrimary: boolean,
  ) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    if (fieldType === 'mobile') {
      const row = await this.prisma.contact_mobiles.findFirst({
        where: { id: fieldId, modelable_id: contactId },
      });
      if (!row) throw new NotFoundException('Mobile not found');
      if (markPrimary) {
        await this.prisma.contact_mobiles.updateMany({
          where: {
            modelable_type: 'App\\Models\\Contact',
            modelable_id: contactId,
            type: row.type ?? 'phone',
          },
          data: { is_primary: 0 },
        });
      }
      await this.prisma.contact_mobiles.update({
        where: { id: fieldId },
        data: { is_primary: markPrimary ? 1 : 0 },
      });
    } else {
      if (markPrimary) {
        await this.prisma.contact_emails.updateMany({
          where: {
            modelable_type: 'App\\Models\\Contact',
            modelable_id: contactId,
          },
          data: { is_primary: 0 },
        });
      }
      await this.prisma.contact_emails.update({
        where: { id: fieldId },
        data: { is_primary: markPrimary ? 1 : 0 },
      });
    }
    return await this.getContact(workspaceId, contactId);
  }

  /**
   * Mark a contact's opt-in row as unsubscribed. Mirrors replyagent's
   * POST /contact/unsubscribe/:optinId { contact_id }. We best-effort look
   * up an `optins` table — schemas vary, so a missing model returns success
   * without error rather than crashing.
   */
  async unsubscribe(workspaceId: bigint, contactId: bigint, optinId: bigint) {
    try {
      await (this.prisma as any).optins?.update?.({
        where: { id: optinId },
        data: { is_subscribed: 0, unsubscribed_at: new Date() },
      });
    } catch {}
    return { success: true };
  }

  async optin(workspaceId: bigint, contactId: bigint, data: any) {
    try {
      await (this.prisma as any).optins?.create?.({
        data: {
          workspace_id: workspaceId,
          contact_id: contactId,
          channel: data.channel ?? null,
          is_subscribed: 1,
        },
      });
    } catch {}
    return { success: true };
  }

  /**
   * Fetch a contact's full detail for the merge-preview pane. Same shape as
   * getContact() but returns the lean payload the MergeContacts modal binds
   * to (mobile_contacts/email_contacts/whatsapp_chats/etc.).
   */
  async getContactForMerge(workspaceId: bigint, contactId: bigint) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const [mobiles, emails, tagLinks] = await Promise.all([
      this.prisma.contact_mobiles.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: contact.id,
        },
      }),
      this.prisma.contact_emails.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: contact.id,
        },
      }),
      this.prisma.tag_links.findMany({
        where: {
          linkable_type: 'App\\Models\\Contact',
          linkable_id: contact.id,
        },
      }),
    ]);

    return {
      ...this.serialize(contact),
      slug: contact.id.toString(),
      full_name:
        `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() ||
        'Unnamed',
      picture: '/images/avatar.png',
      mobile_contacts: mobiles.map((m) => ({
        ...this.serializeMobile(m),
        slug: String(m.type ?? 'mobile').toLowerCase() === 'whatsapp'
          ? 'whatsapp'
          : 'mobile',
        national_mobile_number: m.full_mobile_number ?? m.mobile_number ?? '',
      })),
      email_contacts: emails.map((e) => ({
        id: e.id.toString(),
        email: e.email,
        is_primary: !!e.is_primary,
      })),
      tag_links: tagLinks.map((tl) => ({
        id: tl.id.toString(),
        name: tl.name,
        tag_id: tl.tag_id?.toString(),
      })),
      custom_fields_data: [],
      telegram_chats: [],
      whatsapp_chats: mobiles
        .filter((m) => String(m.type ?? '').toLowerCase() === 'whatsapp')
        .map((m) => ({
          id: m.id.toString(),
          wa_id: m.full_mobile_number ?? m.mobile_number ?? '',
          profile_name: contact.full_name ?? '',
        })),
      facebook_chats: [],
      instagram_chats: [],
    };
  }

  /**
   * Search candidate destination contacts for a merge. Mirrors replyagent's
   * POST /contact/search-destination { current_contact_id, key }.
   */
  async searchDestinationContacts(
    workspaceId: bigint,
    currentContactId: bigint,
    key: string,
  ) {
    const trimmed = String(key ?? '').trim();
    if (trimmed.length < 3) return { contacts: [] };

    const contacts = await this.prisma.contacts.findMany({
      where: {
        workspace_id: workspaceId,
        deleted_at: null,
        id: { not: currentContactId },
        OR: [
          { first_name: { contains: trimmed } },
          { last_name: { contains: trimmed } },
          { full_name: { contains: trimmed } },
        ],
      },
      take: 20,
      orderBy: { id: 'desc' },
    });

    return {
      contacts: contacts.map((c) => ({
        id: c.id.toString(),
        slug: c.id.toString(),
        full_name:
          c.full_name ||
          `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() ||
          'Unnamed',
        picture: '/images/avatar.png',
        created_at: c.created_at,
      })),
    };
  }

  /**
   * Merge two contacts. The destination keeps the older `created_at`, takes
   * over all phones / emails / tags / custom fields / chat threads from the
   * source, and the source is soft-deleted. Returns the merged contact.
   */
  async mergeContacts(
    workspaceId: bigint,
    currentContactId: bigint,
    destinationContactId: bigint,
  ) {
    if (currentContactId === destinationContactId) {
      throw new BadRequestException('Cannot merge a contact into itself');
    }

    const [current, dest] = await Promise.all([
      this.prisma.contacts.findFirst({
        where: { id: currentContactId, workspace_id: workspaceId },
      }),
      this.prisma.contacts.findFirst({
        where: { id: destinationContactId, workspace_id: workspaceId },
      }),
    ]);
    if (!current || !dest) throw new NotFoundException('Contact not found');

    // 1. Move all phones / emails to the destination, skip duplicates.
    const [currentMobiles, destMobiles] = await Promise.all([
      this.prisma.contact_mobiles.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: current.id,
        },
      }),
      this.prisma.contact_mobiles.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: dest.id,
        },
      }),
    ]);
    const destMobileSet = new Set(
      destMobiles.map((m) => m.full_mobile_number ?? m.mobile_number ?? ''),
    );
    for (const m of currentMobiles) {
      const key = m.full_mobile_number ?? m.mobile_number ?? '';
      if (destMobileSet.has(key)) {
        await this.prisma.contact_mobiles.delete({ where: { id: m.id } });
      } else {
        await this.prisma.contact_mobiles.update({
          where: { id: m.id },
          data: { modelable_id: dest.id },
        });
      }
    }

    const [currentEmails, destEmails] = await Promise.all([
      this.prisma.contact_emails.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: current.id,
        },
      }),
      this.prisma.contact_emails.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: dest.id,
        },
      }),
    ]);
    const destEmailSet = new Set(destEmails.map((e) => e.email));
    for (const e of currentEmails) {
      if (destEmailSet.has(e.email)) {
        await this.prisma.contact_emails.delete({ where: { id: e.id } });
      } else {
        await this.prisma.contact_emails.update({
          where: { id: e.id },
          data: { modelable_id: dest.id },
        });
      }
    }

    // 2. Move tag_links; dedupe by tag_id.
    const [currentTagLinks, destTagLinks] = await Promise.all([
      this.prisma.tag_links.findMany({
        where: {
          linkable_type: 'App\\Models\\Contact',
          linkable_id: current.id,
        },
      }),
      this.prisma.tag_links.findMany({
        where: {
          linkable_type: 'App\\Models\\Contact',
          linkable_id: dest.id,
        },
      }),
    ]);
    const destTagSet = new Set(
      destTagLinks.map((t) => t.tag_id?.toString() ?? ''),
    );
    for (const tl of currentTagLinks) {
      if (destTagSet.has(tl.tag_id?.toString() ?? '')) {
        await this.prisma.tag_links.delete({ where: { id: tl.id } });
      } else {
        await this.prisma.tag_links.update({
          where: { id: tl.id },
          data: { linkable_id: dest.id },
        });
      }
    }

    // 3. Move conversations to the destination contact. The `inbox` table
    //    has no `contact_id` column — it's polymorphic via modelable_type/id.
    //    Each per-channel chats table owns the `contact_id` foreign key, so
    //    we reassign there instead. (best-effort per table — missing models
    //    on some workspace builds are tolerated.)
    const reassignContact = async (table: any) => {
      try {
        await table.updateMany({
          where: { contact_id: current.id },
          data: { contact_id: dest.id },
        });
      } catch {}
    };
    await Promise.all([
      reassignContact(this.prisma.wa_chats),
      reassignContact(this.prisma.telegram_chats),
      reassignContact(this.prisma.fb_chats),
      reassignContact(this.prisma.insta_chats),
      reassignContact(this.prisma.evolution_chats),
      reassignContact(this.prisma.zapi_chats),
      reassignContact(this.prisma.twilio_chats),
    ]);
    await (this.prisma as any).notes
      ?.updateMany?.({
        where: { contact_id: current.id, workspace_id: workspaceId },
        data: { contact_id: dest.id },
      })
      .catch(() => null);
    await this.prisma.tasks
      .updateMany({
        where: { contact_id: current.id, workspace_id: workspaceId },
        data: { contact_id: dest.id },
      })
      .catch(() => null);
    await this.prisma.bookings
      .updateMany({
        where: { contact_id: current.id, workspace_id: workspaceId },
        data: { contact_id: dest.id },
      })
      .catch(() => null);

    // 4. Pick the earlier created_at so the merged contact keeps its history.
    const earlierCreatedAt =
      current.created_at && dest.created_at
        ? current.created_at < dest.created_at
          ? current.created_at
          : dest.created_at
        : current.created_at ?? dest.created_at ?? new Date();
    await this.prisma.contacts.update({
      where: { id: dest.id },
      data: { created_at: earlierCreatedAt },
    });

    // 5. Soft-delete the source contact.
    await this.prisma.contacts.update({
      where: { id: current.id },
      data: { deleted_at: new Date() },
    });

    this.eventEmitter.emit('contact.merged', {
      workspaceId,
      sourceId: current.id,
      destinationId: dest.id,
    });

    const merged = await this.getContact(workspaceId, dest.id);
    return { success: true, contact: merged.contact };
  }

  /**
   * Move a contact to a different company (or unlink). Body: { company_id }.
   * Replyagent endpoint: POST /company/assign[/:company_id].
   */
  async changeCompany(
    workspaceId: bigint,
    contactId: bigint,
    companyId: bigint | null,
  ) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { company_id: companyId },
    });

    this.eventEmitter.emit('contact.company_changed', {
      contactId,
      workspaceId,
      companyId,
    });

    return await this.getContact(workspaceId, contactId);
  }

  /**
   * Download a contact's conversation history as a plain-text transcript.
   * Returns the text; the controller wraps it in a downloadable response.
   *
   * The schema has no unified `inbox_messages` table or `inbox.contact_id`
   * column — each channel has its own chats table (wa_chats, telegram_chats,
   * fb_chats, insta_chats, evolution_chats, zapi_chats, twilio_chats), each
   * with `contact_id`, and a matching messages table (wa_messages, …) keyed
   * by `{channel}_chat_id`. So we gather chat ids per channel, pull messages
   * across channels, then sort by created_at.
   */
  async downloadConversation(workspaceId: bigint, contactId: bigint) {
    const idSelect = { select: { id: true } } as any;
    const [waChats, tgChats, fbChats, igChats, evoChats, zapiChats, twChats] =
      await Promise.all([
        this.prisma.wa_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
        this.prisma.telegram_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
        this.prisma.fb_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
        this.prisma.insta_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
        this.prisma.evolution_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
        this.prisma.zapi_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
        this.prisma.twilio_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      ]);

    const wa = waChats.map((c: any) => c.id);
    const tg = tgChats.map((c: any) => c.id);
    const fb = fbChats.map((c: any) => c.id);
    const ig = igChats.map((c: any) => c.id);
    const evo = evoChats.map((c: any) => c.id);
    const zapi = zapiChats.map((c: any) => c.id);
    const tw = twChats.map((c: any) => c.id);

    const buckets = await Promise.all([
      wa.length
        ? this.prisma.wa_messages
            .findMany({ where: { wa_chat_id: { in: wa } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'WhatsApp' })))
            .catch(() => [] as any[])
        : [],
      tg.length
        ? this.prisma.telegram_messages
            .findMany({ where: { telegram_chat_id: { in: tg } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'Telegram' })))
            .catch(() => [] as any[])
        : [],
      fb.length
        ? this.prisma.fb_messages
            .findMany({ where: { fb_chat_id: { in: fb } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'Messenger' })))
            .catch(() => [] as any[])
        : [],
      ig.length
        ? this.prisma.insta_messages
            .findMany({ where: { insta_chat_id: { in: ig } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'Instagram' })))
            .catch(() => [] as any[])
        : [],
      evo.length
        ? this.prisma.evolution_messages
            .findMany({ where: { evolution_chat_id: { in: evo } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'Evolution' })))
            .catch(() => [] as any[])
        : [],
      zapi.length
        ? this.prisma.zapi_messages
            .findMany({ where: { zapi_chat_id: { in: zapi } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'Z-API' })))
            .catch(() => [] as any[])
        : [],
      tw.length
        ? this.prisma.twilio_messages
            .findMany({ where: { twilio_chat_id: { in: tw } }, orderBy: { created_at: 'asc' } })
            .then((rs) => rs.map((m: any) => ({ ...m, _channel: 'SMS' })))
            .catch(() => [] as any[])
        : [],
    ]);

    const all = buckets.flat();
    all.sort((a, b) => {
      const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ad - bd;
    });

    const lines = [
      `Conversation history for contact ${contactId.toString()}`,
      `Exported: ${new Date().toISOString()}`,
      '',
    ];
    for (const m of all) {
      const ts = m.created_at ? new Date(m.created_at).toISOString() : '';
      const dir = String(m.direction ?? '').toUpperCase();
      const sender = dir === 'OUTGOING' || dir === 'OUTBOUND' ? 'Agent' : 'Contact';
      lines.push(`[${ts}] [${m._channel}] ${sender}: ${m.text ?? '(media)'}`);
    }
    return lines.join('\n');
  }

  // ─── Bulk operations (mirror gateway's BulkTagAction / BulkCustomFieldAction jobs) ─────────────────

  /** Apply one or more tags to many contacts. Idempotent — skips existing links. */
  async applyTagsBulk(workspaceId: bigint, contactIds: bigint[], tagIds: bigint[]) {
    if (contactIds.length === 0 || tagIds.length === 0) return { applied: 0 };
    const valid = await this.prisma.contacts.findMany({
      where: { id: { in: contactIds }, workspace_id: workspaceId },
      select: { id: true },
    });
    const tags = await this.prisma.tags.findMany({
      where: { id: { in: tagIds }, workspace_id: workspaceId },
      select: { id: true, name: true },
    });

    let applied = 0;
    for (const c of valid) {
      for (const t of tags) {
        const existing = await this.prisma.tag_links.findFirst({
          where: {
            linkable_type: 'App\\Models\\Contact',
            linkable_id: c.id,
            tag_id: t.id,
          },
        });
        if (!existing) {
          await this.prisma.tag_links.create({
            data: {
              linkable_type: 'App\\Models\\Contact',
              linkable_id: c.id,
              tag_id: t.id,
              name: t.name,
              created_at: new Date(),
              updated_at: new Date(),
            },
          });
          applied++;
        }
      }
    }
    return { applied, contacts: valid.length, tags: tags.length };
  }

  async removeTagsBulk(workspaceId: bigint, contactIds: bigint[], tagIds: bigint[]) {
    if (contactIds.length === 0 || tagIds.length === 0) return { removed: 0 };
    const valid = await this.prisma.contacts.findMany({
      where: { id: { in: contactIds }, workspace_id: workspaceId },
      select: { id: true },
    });
    const validIds = valid.map((c) => c.id);

    // Capture-then-delete so we can fire `contact.tag_removed` for each
    // (contact, tag) pair — required for AutomationTriggerService's
    // tag_removed listener to dispatch matching trigger activities.
    const linksToRemove = await this.prisma.tag_links.findMany({
      where: {
        linkable_type: 'App\\Models\\Contact',
        linkable_id: { in: validIds },
        tag_id: { in: tagIds },
      },
      select: { linkable_id: true, tag_id: true },
    });
    const result = await this.prisma.tag_links.deleteMany({
      where: {
        linkable_type: 'App\\Models\\Contact',
        linkable_id: { in: validIds },
        tag_id: { in: tagIds },
      },
    });
    for (const link of linksToRemove) {
      this.eventEmitter.emit('contact.tag_removed', {
        contactId: link.linkable_id,
        tagId: link.tag_id,
        workspaceId,
      });
    }
    return { removed: result.count };
  }

  /**
   * Export contacts to CSV. Returns the raw CSV string; the controller adds
   * the Content-Disposition header. Columns: id, first_name, last_name,
   * full_name, email (first), phone (first), tags (semicolon-joined), created_at.
   */
  async exportCsv(workspaceId: bigint, filters: { status?: string } = {}) {
    const where: any = { workspace_id: workspaceId, deleted_at: null };
    if (filters.status) where.status = filters.status;

    const contacts = await this.prisma.contacts.findMany({
      where,
      orderBy: { id: 'asc' },
      take: 10000,
    });

    const lines: string[] = [
      'id,first_name,last_name,full_name,email,phone,tags,created_at',
    ];
    for (const c of contacts) {
      const emailRow = await this.prisma.contact_emails.findFirst({
        where: {
          ownership_id: workspaceId,
          modelable_type: 'App\\Models\\Contact',
          modelable_id: c.id,
        } as any,
        select: { email: true },
      });
      const phoneRow = await this.prisma.contact_mobiles.findFirst({
        where: {
          ownership_id: workspaceId,
          modelable_type: 'App\\Models\\Contact',
          modelable_id: c.id,
        } as any,
        select: { full_mobile_number: true },
      });
      const tagLinks = await this.prisma.tag_links.findMany({
        where: { linkable_type: 'App\\Models\\Contact', linkable_id: c.id },
        select: { name: true },
      });
      const row = [
        c.id.toString(),
        this.csvEscape(c.first_name ?? ''),
        this.csvEscape(c.last_name ?? ''),
        this.csvEscape(c.full_name ?? ''),
        this.csvEscape(emailRow?.email ?? ''),
        this.csvEscape(phoneRow?.full_mobile_number ?? ''),
        this.csvEscape(tagLinks.map((t) => t.name).join(';')),
        c.created_at ? c.created_at.toISOString() : '',
      ].join(',');
      lines.push(row);
    }
    return lines.join('\n');
  }

  /**
   * Import a CSV. Header expected: first_name,last_name,email,phone[,tags]
   * Tags column is semicolon-separated; tags auto-created if missing.
   * Existing contacts matched by email/phone are updated; otherwise created.
   */
  async importCsv(workspaceId: bigint, userId: bigint, csv: string) {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      throw new BadRequestException('CSV is empty or has no rows');
    }
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const idxFirst = header.indexOf('first_name');
    const idxLast = header.indexOf('last_name');
    const idxEmail = header.indexOf('email');
    const idxPhone = header.indexOf('phone');
    const idxTags = header.indexOf('tags');

    let created = 0;
    let updated = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = this.csvParseLine(lines[i]);
      const first = idxFirst >= 0 ? cols[idxFirst] : '';
      const last = idxLast >= 0 ? cols[idxLast] : '';
      const email = idxEmail >= 0 ? cols[idxEmail] : '';
      const phone = idxPhone >= 0 ? cols[idxPhone] : '';
      const tagsRaw = idxTags >= 0 ? cols[idxTags] : '';

      if (!first && !email && !phone) continue;

      const existing = await this.findExistingContact(workspaceId, email, phone);
      let contactId: bigint;
      if (existing) {
        contactId = existing.id;
        await this.prisma.contacts.update({
          where: { id: existing.id },
          data: {
            first_name: first || existing.first_name,
            last_name: last || existing.last_name,
            updated_at: new Date(),
          },
        });
        updated++;
      } else {
        // Bulk import stops as soon as the cap is hit; already-created rows are kept.
        // Returning early lets the controller surface "Reached the limit" + the partial counts.
        try {
          await this.enforceContactsLimit(workspaceId);
        } catch {
          break;
        }
        const c = await this.prisma.contacts.create({
          data: {
            workspace_id: workspaceId,
            first_name: first || null,
            last_name: last || null,
            source: 'IMPORT' as any,
            status: 'ACTIVE' as any,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
        contactId = c.id;
        if (email) {
          await this.prisma.contact_emails.create({
            data: {
              ownership_type: 'App\\Models\\Workspace',
              ownership_id: workspaceId,
              modelable_type: 'App\\Models\\Contact',
              modelable_id: c.id,
              email,
            } as any,
          });
        }
        if (phone) {
          const clean = phone.replace(/[^0-9]/g, '');
          await this.prisma.contact_mobiles.create({
            data: {
              ownership_type: 'App\\Models\\Workspace',
              ownership_id: workspaceId,
              modelable_type: 'App\\Models\\Contact',
              modelable_id: c.id,
              country_id: 0,
              mobile_number: clean,
              national_mobile_number: clean,
              full_mobile_number: clean,
            },
          });
        }
        created++;
      }

      if (tagsRaw) {
        const names = tagsRaw.split(';').map((s) => s.trim()).filter(Boolean);
        for (const name of names) {
          let tag = await this.prisma.tags.findFirst({
            where: { workspace_id: workspaceId, name } as any,
          });
          if (!tag) {
            tag = await this.prisma.tags.create({
              data: {
                workspace_id: workspaceId,
                user_id: userId,
                taggable_type: 'App\\Models\\Workspace',
                taggable_id: workspaceId,
                name,
                display_inbox: 1,
              } as any,
            });
          }
          const linkExists = await this.prisma.tag_links.findFirst({
            where: {
              linkable_type: 'App\\Models\\Contact',
              linkable_id: contactId,
              tag_id: tag.id,
            },
          });
          if (!linkExists) {
            await this.prisma.tag_links.create({
              data: {
                linkable_type: 'App\\Models\\Contact',
                linkable_id: contactId,
                tag_id: tag.id,
                name: tag.name,
                created_at: new Date(),
                updated_at: new Date(),
              },
            });
          }
        }
      }
    }

    return { created, updated, total: created + updated };
  }

  private csvEscape(v: string): string {
    if (!v) return '';
    if (/[,"\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  private csvParseLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { cur += ch; }
      } else {
        if (ch === ',') { out.push(cur); cur = ''; }
        else if (ch === '"') { inQuotes = true; }
        else { cur += ch; }
      }
    }
    out.push(cur);
    return out;
  }
}
