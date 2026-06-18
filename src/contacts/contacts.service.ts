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

    // Fetch tags + primary mobile in parallel
    const contactIds = contacts.map(c => c.id);
    const [tagLinks, mobiles] = await Promise.all([
      contactIds.length > 0 ? this.prisma.tag_links.findMany({
        where: { linkable_type: 'App\\Models\\Contact', linkable_id: { in: contactIds } },
      }) : Promise.resolve([]),
      contactIds.length > 0 ? this.prisma.contact_mobiles.findMany({
        where: {
          modelable_type: 'App\\Models\\Contact',
          modelable_id: { in: contactIds },
          ownership_type: 'App\\Models\\Workspace',
          ownership_id: workspaceId,
        },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }) : Promise.resolve([]),
    ]);

    const contactsWithData = contacts.map(contact => {
      const contactTags = tagLinks.filter(tl => tl.linkable_id === contact.id);
      const primaryMobile = mobiles.find(m => m.modelable_id === contact.id);
      return {
        ...contact,
        tag_links: contactTags.map(tl => ({ tags: { name: tl.name } })),
        primary_mobile: primaryMobile?.full_mobile_number ?? null,
      };
    });

    return { success: true, contacts: contactsWithData };
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

    // Everything below depends only on contact.id / workspaceId. These used to
    // run as ~13 SEQUENTIAL awaits, each a separate round-trip to the (remote)
    // DB — that's what made the profile take a few seconds to open. Fire the
    // whole independent batch concurrently instead (Wave A), then a small
    // second batch (Wave B) for the two queries that need Wave A's results.
    const [
      tagLinks,
      allMobiles,
      emails,
      tasksCount,
      bookingsCount,
      opportunitiesCount,
      customFields,
      tasks,
      bookings,
      rawOpportunities,
      twilioAccounts,
      supportNumberRow,
      companyContacts,
      adClicks,
      adClicksCount,
      channelOpts,
    ] = await Promise.all([
      this.prisma.tag_links.findMany({
        where: { linkable_type: 'App\\Models\\Contact', linkable_id: contact.id },
      }),
      // Phones / emails — split into WhatsApp vs regular `phone` rows below.
      this.prisma.contact_mobiles.findMany({
        where: { modelable_type: 'App\\Models\\Contact', modelable_id: contact.id },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.contact_emails.findMany({
        where: { modelable_type: 'App\\Models\\Contact', modelable_id: contact.id },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      }),
      // Sidebar counts — best-effort, 0 on any error.
      this.prisma.tasks
        .count({ where: { workspace_id: workspaceId, contact_id: contact.id } })
        .catch(() => 0),
      this.prisma.bookings
        .count({ where: { workspace_id: workspaceId, contact_id: contact.id } })
        .catch(() => 0),
      this.prisma.pipeline_opportunities
        .count({ where: { contact_id: contact.id, workspace_id: workspaceId } })
        .catch(() => 0),
      this.customFieldsService
        .getEntityValues('Contact', contact.id)
        .catch(() => [] as any[]),
      // Sidebar list previews (capped at 5).
      this.prisma.tasks
        .findMany({
          where: { workspace_id: workspaceId, contact_id: contact.id },
          orderBy: [{ datetime: 'desc' }, { id: 'desc' }],
          take: 5,
        })
        .catch(() => [] as any[]),
      this.prisma.bookings
        .findMany({
          where: { workspace_id: workspaceId, contact_id: contact.id },
          orderBy: [{ start: 'desc' }, { id: 'desc' }],
          take: 5,
        })
        .catch(() => [] as any[]),
      this.prisma.pipeline_opportunities
        .findMany({
          where: { contact_id: contact.id, workspace_id: workspaceId },
          orderBy: { created_at: 'desc' },
          take: 5,
        })
        .catch(() => [] as any[]),
      // Workspace's twilio accounts — needed to scope the calls count below.
      this.prisma.twilio_accounts
        .findMany({ where: { workspace_id: workspaceId, deleted_at: null }, select: { id: true } })
        .catch(() => [] as { id: bigint }[]),
      // Latest open Support-Number-Task chip (replyagent parity).
      this.prisma.support_numbers
        .findFirst({
          where: { workspace_id: workspaceId, contact_id: contact.id, is_open: 1 },
          orderBy: { id: 'desc' },
          select: { sn_number: true },
        })
        .catch(() => null),
      // Other contacts in the same company (CONTACTS sidebar section).
      contact.company_id
        ? this.prisma.contacts
            .findMany({
              where: { company_id: contact.company_id, deleted_at: null, id: { not: contact.id } },
              take: 10,
              orderBy: { id: 'asc' },
              select: { id: true, first_name: true, last_name: true, full_name: true },
            })
            .catch(() => [] as any[])
        : Promise.resolve([] as any[]),
      // AD CLICKS — Meta ad-click referrals captured on inbound (replyagent: referrals table).
      this.prisma.referrals
        .findMany({
          where: { contact_id: contact.id, workspace_id: workspaceId },
          orderBy: { id: 'desc' },
          take: 20,
        })
        .catch(() => [] as any[]),
      this.prisma.referrals
        .count({ where: { contact_id: contact.id, workspace_id: workspaceId } })
        .catch(() => 0),
      // Per-field opt-ins — channel_opts.contactable points at the mobile/email row.
      this.prisma.channel_opts
        .findMany({
          where: { contact_id: contact.id },
          select: { id: true, channel: true, contactable_type: true, contactable_id: true, modelable_id: true, modelable_type: true },
        })
        .catch(() => [] as any[]),
    ]);

    // Index per-field opt-ins by the contactable (mobile / email) row id so each
    // serialized number / email can carry an `opted_in` flag + the optin id (for unsubscribe).
    const MOBILE_CONTACTABLE = 'App\\Models\\Contact\\MobileContact';
    const EMAIL_CONTACTABLE = 'App\\Models\\Contact\\EmailContact';
    const optinByMobile = new Map<string, any>();
    const optinByEmail = new Map<string, any>();
    // Per-mobile list of opt-ins (one row per workspace channel number) so the
    // profile dropdown can check `isOpted(workspace_number)` exactly like
    // replyagent's `c.optins` (each carries channel + modelable_id = the
    // wa_phone_numbers id the contact opted in to).
    const optinsByMobile = new Map<string, any[]>();
    for (const o of channelOpts as any[]) {
      if (!o.contactable_id) continue;
      const key = o.contactable_id.toString();
      if (o.contactable_type === MOBILE_CONTACTABLE) {
        optinByMobile.set(key, o);
        const arr = optinsByMobile.get(key) ?? [];
        arr.push({
          id: o.id.toString(),
          channel: o.channel,
          modelable_id: o.modelable_id != null ? o.modelable_id.toString() : null,
        });
        optinsByMobile.set(key, arr);
      } else if (o.contactable_type === EMAIL_CONTACTABLE) optinByEmail.set(key, o);
    }
    const withMobileOptin = (m: any) => {
      const o = optinByMobile.get(m.id.toString());
      return {
        ...this.serializeMobile(m),
        opted_in: !!o,
        optin_id: o ? o.id.toString() : null,
        optins: optinsByMobile.get(m.id.toString()) ?? [],
      };
    };
    const phones = allMobiles
      .filter((m) => String(m.type ?? 'phone').toLowerCase() !== 'whatsapp')
      .map(withMobileOptin);
    const whatsapps = allMobiles
      .filter((m) => String(m.type ?? '').toLowerCase() === 'whatsapp')
      .map(withMobileOptin);
    const supportNumberTask = supportNumberRow?.sn_number ?? null;

    // ─── Wave B — the two lookups that depend on Wave A results ──────
    const allNumbers = allMobiles
      .map((m) => m.full_mobile_number ?? m.mobile_number ?? null)
      .filter((x): x is string => !!x);
    const twilioAccountIds = twilioAccounts.map((a) => a.id);
    const taskUserIds = Array.from(
      new Set(tasks.map((t) => t.user_id).filter((x): x is bigint => !!x)),
    );

    const [taskUsers, callsCount, callsList] = await Promise.all([
      taskUserIds.length
        ? this.prisma.users.findMany({
            where: { id: { in: taskUserIds } },
            select: { id: true, first_name: true, last_name: true },
          })
        : Promise.resolve([] as { id: bigint; first_name: string | null; last_name: string | null }[]),
      allNumbers.length && twilioAccountIds.length
        ? this.prisma.twilio_call_logs
            .count({
              where: {
                twilio_account_id: { in: twilioAccountIds },
                OR: [{ from_number: { in: allNumbers } }, { to_number: { in: allNumbers } }],
              },
            })
            .catch(() => 0)
        : Promise.resolve(0),
      allNumbers.length && twilioAccountIds.length
        ? this.prisma.twilio_call_logs
            .findMany({
              where: {
                twilio_account_id: { in: twilioAccountIds },
                OR: [{ from_number: { in: allNumbers } }, { to_number: { in: allNumbers } }],
              },
              orderBy: { created_at: 'desc' },
              take: 5,
            })
            .catch(() => [] as any[])
        : Promise.resolve([] as any[]),
    ]);
    const taskUserById = new Map(taskUsers.map((u) => [u.id.toString(), u]));

    // Enrich opportunities with step + pipeline names (same pattern as inbox.service).
    let enrichedOpportunities: any[] = [];
    if ((rawOpportunities as any[]).length > 0) {
      try {
        const stepIds = [...new Set((rawOpportunities as any[]).map((o) => o.pl_step_id))];
        const plIds   = [...new Set((rawOpportunities as any[]).map((o) => o.pl_id))];
        const [steps, pls] = await Promise.all([
          this.prisma.pipeline_steps.findMany({
            where: { id: { in: stepIds } },
            select: { id: true, name: true, bg_color: true, txt_color: true },
          }),
          this.prisma.pipelines.findMany({
            where: { id: { in: plIds } },
            select: { id: true, name: true, currency: true },
          }),
        ]);
        const stepMap = new Map((steps as any[]).map((s) => [s.id.toString(), s]));
        const plMap   = new Map((pls as any[]).map((p) => [p.id.toString(), p]));
        enrichedOpportunities = (rawOpportunities as any[]).map((o) => ({
          id: o.id.toString(),
          title: o.title,
          name: o.title,
          value: o.value ? Number(o.value) : 0,
          currency: o.currency,
          status: o.status,
          closing_date: o.closing_date,
          probability: o.probability,
          pipeline_step_name: stepMap.get(o.pl_step_id?.toString())?.name ?? null,
          step: stepMap.get(o.pl_step_id?.toString()) ?? null,
          pipeline: plMap.get(o.pl_id?.toString()) ?? null,
        }));
      } catch { /* best-effort */ }
    }

    return {
      success: true,
      contact: {
        ...this.serialize(contact),
        tag_links: tagLinks.map((tl) => ({ tags: { name: tl.name } })),
        tags: tagLinks.map((tl) => tl.name),
        phones,
        whatsapps,
        emails: emails.map((e) => {
          const o = optinByEmail.get(e.id.toString());
          return {
            id: e.id.toString(),
            email: e.email,
            type: e.type,
            is_primary: !!e.is_primary,
            created_at: e.created_at,
            opted_in: !!o,
            optin_id: o ? o.id.toString() : null,
          };
        }),
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
          ad_clicks: adClicksCount,
          opportunities: opportunitiesCount,
          groups: 0,
        },
        opportunities: enrichedOpportunities,
        ad_clicks: (adClicks as any[]).map((r) => ({
          id: r.id.toString(),
          ad_id: r.ad_id,
          title: r.title ?? null,
          subtitle: r.subtitle ?? null,
          source: r.source ?? null,
          type: r.type ?? null,
          created_at: r.created_at,
        })),
        calls: (callsList as any[]).map((c) => ({
          id: c.id.toString(),
          from_number: c.from_number,
          to_number: c.to_number,
          call_duration: c.call_duration,
          call_type: c.call_type,
          status: c.status,
          created_at: c.created_at,
          transcription: this.extractTranscription(c),
        })),
        company_contacts: (companyContacts as any[]).map((c) => ({
          id: c.id.toString(),
          full_name: (c.full_name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()) || 'Unnamed',
        })),
      },
    };
  }

  /** Pull a transcription string out of a twilio_call_logs row's metadata JSON, if present. */
  private extractTranscription(c: any): string | null {
    for (const raw of [c?.metadata, c?.twilio_metadata]) {
      if (!raw) continue;
      try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const t = obj?.transcription ?? obj?.transcript ?? obj?.transcription_text ?? null;
        if (t) return typeof t === 'string' ? t : JSON.stringify(t);
      } catch {
        /* metadata isn't JSON — ignore */
      }
    }
    return null;
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

  /** Strip everything except digits. */
  private cleanDigits(s: string): string {
    return (s || '').replace(/[^\d]/g, '');
  }

  /**
   * Best-effort country lookup by dialing-code prefix on a digits-only string.
   * Mirrors whatsapp-events.consumer.detectCountryId so manual + inbound contacts
   * resolve the same country. Returns the matched code, the remaining national
   * digits, and the country row (null if nothing matched).
   */
  private async detectCountryByPrefix(digits: string) {
    for (const len of [3, 2, 1]) {
      if (digits.length <= len) continue;
      const prefix = digits.slice(0, len);
      const c = await this.prisma.countries.findFirst({
        where: { phone_code: prefix },
        select: { id: true, phone_code: true },
      });
      if (c) return { code: prefix, national: digits.slice(len), country: c };
    }
    return { code: '', national: digits, country: null as any };
  }

  /**
   * Normalise a raw phone number into the SAME canonical shape replyagent stores
   * (parseMobileNumber): full_mobile_number = "+CCNNN", national_mobile_number =
   * "CCNNN", mobile_number = national digits, plus country_code + country_id.
   * This is the dedup key — it MUST match what the WhatsApp inbound path writes
   * (+ followed by full international digits) or manual + inbound contacts diverge.
   *
   * - If a country is selected and the input is in local form, the country's
   *   dialing code is prepended (after stripping a leading 0).
   * - If the input is already international (+, 00, or bare country code), the
   *   country is detected from the prefix.
   */
  private async normalizeMobile(rawPhone: string, countryId?: bigint | number | string) {
    const raw = (rawPhone || '').trim();
    let country: any = null;
    if (countryId) {
      country = await this.prisma.countries
        .findUnique({ where: { id: BigInt(countryId) }, select: { id: true, phone_code: true } })
        .catch(() => null);
    }

    let codeDigits = country?.phone_code ? this.cleanDigits(String(country.phone_code)) : '';
    let nationalDigits: string;
    const isIntl = raw.startsWith('+') || raw.startsWith('00');

    if (country && !isIntl) {
      // Local number entered with an explicit country → prepend its dialing code.
      nationalDigits = this.cleanDigits(raw).replace(/^0+/, '');
    } else {
      // International form: strip + / 00, then split off the country code.
      let intl = raw.startsWith('00') ? raw.slice(2) : raw.replace(/^\+/, '');
      intl = this.cleanDigits(intl);
      if (codeDigits && intl.startsWith(codeDigits)) {
        nationalDigits = intl.slice(codeDigits.length);
      } else if (codeDigits) {
        nationalDigits = intl.replace(/^0+/, '');
      } else {
        const det = await this.detectCountryByPrefix(intl);
        codeDigits = det.code;
        country = det.country ?? country;
        nationalDigits = det.national;
      }
    }

    const fullDigits = `${codeDigits}${nationalDigits}`;
    return {
      country_id: country?.id ?? null,
      country_code: codeDigits || null,
      mobile_number: nationalDigits,
      national_mobile_number: fullDigits,
      full_mobile_number: `+${fullDigits}`,
    };
  }

  /**
   * Find a LIVE (non-deleted) contact in this workspace that owns the given
   * canonical mobile number. Searches both +CCNNN and CCNNN forms and ignores
   * stale mobile rows pointing at soft-deleted contacts (same defence as the
   * WhatsApp inbound resolveContact fix).
   */
  async findContactByMobile(workspaceId: bigint, fullMobile: string) {
    const fullNoPlus = fullMobile.startsWith('+') ? fullMobile.slice(1) : fullMobile;
    const mobiles = await this.prisma.contact_mobiles.findMany({
      where: {
        ownership_type: 'App\\Models\\Workspace',
        ownership_id: workspaceId,
        modelable_type: 'App\\Models\\Contact',
        OR: [{ full_mobile_number: fullMobile }, { full_mobile_number: fullNoPlus }],
      },
      select: { modelable_id: true },
    });
    if (!mobiles.length) return null;
    return this.prisma.contacts.findFirst({
      where: { id: { in: mobiles.map((m) => m.modelable_id) }, deleted_at: null },
      orderBy: { id: 'asc' },
    });
  }

  /** Find a LIVE contact in this workspace that owns the given email address. */
  async findContactByEmail(workspaceId: bigint, email: string) {
    const emails = await this.prisma.contact_emails.findMany({
      where: {
        ownership_type: 'App\\Models\\Workspace',
        ownership_id: workspaceId,
        modelable_type: 'App\\Models\\Contact',
        email,
      },
      select: { modelable_id: true },
    });
    if (!emails.length) return null;
    return this.prisma.contacts.findFirst({
      where: { id: { in: emails.map((e) => e.modelable_id) }, deleted_at: null },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Check if contact already exists by email or phone in workspace. Phone is
   * normalised first so "+92..", "92.." and local forms all resolve to the same
   * canonical key. Used by CSV import (reuse-on-match); manual create uses the
   * dedicated reject path in addContact().
   */
  async findExistingContact(workspaceId: bigint, email?: string, phone?: string) {
    if (email) {
      const c = await this.findContactByEmail(workspaceId, email);
      if (c) return c;
    }
    if (phone) {
      const norm = await this.normalizeMobile(phone);
      const c = await this.findContactByMobile(workspaceId, norm.full_mobile_number);
      if (c) return c;
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
      // replyagent parity (ContactHelper::updateContactFields): a duplicate mobile
      // or email is REJECTED with an error — it does NOT silently reuse, and it
      // ignores soft-deleted contacts (so a number whose old contact was deleted
      // can be re-added). Normalise the phone first so the dedup key matches the
      // WhatsApp inbound path (+CCNNN).
      const norm = data.phone ? await this.normalizeMobile(data.phone, data.country_id) : null;

      if (norm?.mobile_number) {
        const dup = await this.findContactByMobile(workspaceId, norm.full_mobile_number);
        if (dup) {
          throw new BadRequestException(`Mobile number ${norm.full_mobile_number} already exists`);
        }
      }
      if (data.email) {
        const dupEmail = await this.findContactByEmail(workspaceId, data.email);
        if (dupEmail) {
          throw new BadRequestException(`Email ${data.email} already exists`);
        }
      }

      await this.enforceContactsLimit(workspaceId);

      contact = await this.prisma.contacts.create({
        data: {
          ...payload,
          workspace_id: workspaceId,
          source: 'MANUAL',
          status: 'ACTIVE', // replyagent default; PENDING was wrong (only used when limit hit)
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
      if (norm?.mobile_number) {
        await this.prisma.contact_mobiles.create({
          data: {
            ownership_id: workspaceId,
            ownership_type: 'App\\Models\\Workspace',
            modelable_id: contact.id,
            modelable_type: 'App\\Models\\Contact',
            full_mobile_number: norm.full_mobile_number,
            national_mobile_number: norm.national_mobile_number,
            mobile_number: norm.mobile_number,
            country_code: norm.country_code,
            country_id: norm.country_id ?? BigInt(data.country_id || 1),
            type: 'mobile',
            slug: 'mobile',
            is_primary: 1,
          } as any,
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

      // Add a phone / email value from the inline "Add phone/email" dialogs
      // (PATCH { phone|email, type, mark_primary }). updateContactData previously
      // ignored these keys, so those dialogs silently did nothing. Normalised +
      // deduped like manual create; stores type + slug + primary.
      if (data.phone) {
        const norm = await this.normalizeMobile(data.phone, data.country_id);
        if (norm?.mobile_number) {
          const dup = await this.findContactByMobile(workspaceId, norm.full_mobile_number);
          if (dup && dup.id !== contactId) {
            throw new BadRequestException(`Mobile number ${norm.full_mobile_number} already exists`);
          }
          if (!dup) {
            const slug = data.slug === 'whatsapp' ? 'whatsapp' : 'mobile';
            if (data.mark_primary) {
              await this.prisma.contact_mobiles.updateMany({
                where: { modelable_type: 'App\\Models\\Contact', modelable_id: contactId },
                data: { is_primary: 0 },
              });
            }
            await this.prisma.contact_mobiles.create({
              data: {
                ownership_id: workspaceId,
                ownership_type: 'App\\Models\\Workspace',
                modelable_id: contactId,
                modelable_type: 'App\\Models\\Contact',
                full_mobile_number: norm.full_mobile_number,
                national_mobile_number: norm.national_mobile_number,
                mobile_number: norm.mobile_number,
                country_code: norm.country_code,
                country_id: norm.country_id ?? BigInt(data.country_id || 1),
                type: data.type || slug,
                slug,
                is_primary: data.mark_primary ? 1 : 0,
              } as any,
            });
          }
        }
      }

      if (data.email) {
        const dupEmail = await this.findContactByEmail(workspaceId, data.email);
        if (dupEmail && dupEmail.id !== contactId) {
          throw new BadRequestException(`Email ${data.email} already exists`);
        }
        if (!dupEmail) {
          if (data.mark_primary) {
            await this.prisma.contact_emails.updateMany({
              where: { modelable_type: 'App\\Models\\Contact', modelable_id: contactId },
              data: { is_primary: 0 },
            });
          }
          await this.prisma.contact_emails.create({
            data: {
              ownership_id: workspaceId,
              ownership_type: 'App\\Models\\Workspace',
              modelable_id: contactId,
              modelable_type: 'App\\Models\\Contact',
              email: data.email,
              type: data.type || 'work',
              slug: 'email',
              is_primary: data.mark_primary ? 1 : 0,
            } as any,
          });
        }
      }

      // Edit an EXISTING phone/whatsapp value inline (replyagent's number
      // edit-mode → save). Re-normalises + dedups so an edit can't collide with
      // another contact's number. update_mobile: { id, value, type, country_id }.
      if (data.update_mobile && data.update_mobile.id) {
        const rowId = BigInt(data.update_mobile.id);
        const row = await this.prisma.contact_mobiles.findFirst({
          where: { id: rowId, modelable_type: 'App\\Models\\Contact', modelable_id: contactId },
        });
        if (row) {
          const newVal = data.update_mobile.value;
          if (newVal !== undefined && newVal !== null && String(newVal).trim() !== '') {
            const norm = await this.normalizeMobile(String(newVal), data.update_mobile.country_id);
            if (norm?.mobile_number) {
              const dup = await this.findContactByMobile(workspaceId, norm.full_mobile_number);
              if (dup && dup.id !== contactId) {
                throw new BadRequestException(`Mobile number ${norm.full_mobile_number} already exists`);
              }
              await this.prisma.contact_mobiles.update({
                where: { id: rowId },
                data: {
                  full_mobile_number: norm.full_mobile_number,
                  national_mobile_number: norm.national_mobile_number,
                  mobile_number: norm.mobile_number,
                  country_code: norm.country_code,
                  ...(norm.country_id ? { country_id: norm.country_id } : {}),
                  ...(data.update_mobile.type ? { type: data.update_mobile.type } : {}),
                } as any,
              });
            }
          } else if (data.update_mobile.type) {
            await this.prisma.contact_mobiles.update({
              where: { id: rowId },
              data: { type: data.update_mobile.type } as any,
            });
          }
        }
      }

      // Edit an existing email value inline. update_email: { id, value, type }.
      if (data.update_email && data.update_email.id) {
        const rowId = BigInt(data.update_email.id);
        const row = await this.prisma.contact_emails.findFirst({
          where: { id: rowId, modelable_type: 'App\\Models\\Contact', modelable_id: contactId },
        });
        if (row) {
          const newVal = data.update_email.value;
          if (newVal !== undefined && newVal !== null && String(newVal).trim() !== '') {
            const dupEmail = await this.findContactByEmail(workspaceId, String(newVal));
            if (dupEmail && dupEmail.id !== contactId) {
              throw new BadRequestException(`Email ${newVal} already exists`);
            }
            await this.prisma.contact_emails.update({
              where: { id: rowId },
              data: {
                email: String(newVal),
                ...(data.update_email.type ? { type: data.update_email.type } : {}),
              } as any,
            });
          } else if (data.update_email.type) {
            await this.prisma.contact_emails.update({
              where: { id: rowId },
              data: { type: data.update_email.type } as any,
            });
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
    // 1. Find all chat IDs linked to this contact across every channel.
    const [evChats, fbChats, instaChats, tgChats, wcChats, zapiChats] = await Promise.all([
      this.prisma.evolution_chats.findMany({ where: { contact_id: contactId }, select: { id: true } }).catch(() => []),
      this.prisma.fb_chats.findMany({ where: { contact_id: contactId }, select: { id: true } }).catch(() => []),
      this.prisma.insta_chats.findMany({ where: { contact_id: contactId }, select: { id: true } }).catch(() => []),
      this.prisma.telegram_chats.findMany({ where: { contact_id: contactId }, select: { id: true } }).catch(() => []),
      this.prisma.wc_chats.findMany({ where: { contact_id: contactId }, select: { id: true } }).catch(() => []),
      this.prisma.zapi_chats.findMany({ where: { contact_id: contactId }, select: { id: true } }).catch(() => []),
    ]);

    // 2. Delete inbox records for each chat type (best-effort, don't fail delete if this errors).
    const inboxDeletes: Promise<any>[] = [];
    if ((evChats as any[]).length)
      inboxDeletes.push(this.prisma.inbox.deleteMany({ where: { modelable_type: { contains: 'WhatsappChat' }, modelable_id: { in: (evChats as any[]).map((c) => c.id) } } }).catch(() => null));
    if ((fbChats as any[]).length)
      inboxDeletes.push(this.prisma.inbox.deleteMany({ where: { modelable_type: { contains: 'FacebookChat' }, modelable_id: { in: (fbChats as any[]).map((c) => c.id) } } }).catch(() => null));
    if ((instaChats as any[]).length)
      inboxDeletes.push(this.prisma.inbox.deleteMany({ where: { modelable_type: { contains: 'InstaChat' }, modelable_id: { in: (instaChats as any[]).map((c) => c.id) } } }).catch(() => null));
    if ((tgChats as any[]).length)
      inboxDeletes.push(this.prisma.inbox.deleteMany({ where: { modelable_type: { contains: 'TelegramChat' }, modelable_id: { in: (tgChats as any[]).map((c) => c.id) } } }).catch(() => null));
    if ((wcChats as any[]).length)
      inboxDeletes.push(this.prisma.inbox.deleteMany({ where: { modelable_type: { contains: 'WcChat' }, modelable_id: { in: (wcChats as any[]).map((c) => c.id) } } }).catch(() => null));
    if ((zapiChats as any[]).length)
      inboxDeletes.push(this.prisma.inbox.deleteMany({ where: { modelable_type: { contains: 'ZapiChat' }, modelable_id: { in: (zapiChats as any[]).map((c) => c.id) } } }).catch(() => null));
    await Promise.all(inboxDeletes);

    // 2b. WhatsApp Cloud chats (wa_chats) — these were MISSING from the lookup
    // above, so deleting a contact never removed its WhatsApp conversation.
    // Remove the inbox row (by type+id — robust against morph-string quirks),
    // the messages, and the chat itself so the conversation fully disappears.
    const waChats = await this.prisma.wa_chats
      .findMany({ where: { contact_id: contactId }, select: { id: true } })
      .catch(() => [] as { id: bigint }[]);
    if (waChats.length) {
      const ids = waChats.map((c) => c.id);
      await this.prisma.inbox
        .deleteMany({ where: { type: 'WHATSAPP', modelable_id: { in: ids } } })
        .catch(() => null);
      await this.prisma.wa_messages.deleteMany({ where: { wa_chat_id: { in: ids } } }).catch(() => null);
      await this.prisma.wa_chats.deleteMany({ where: { id: { in: ids } } }).catch(() => null);
    }

    // 3. Soft-delete the contact.
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
    // Opt-out = remove the channel_opts row (replyagent: ChannelOpt presence = opted in).
    // Scoped to the contact so an agent can't delete another contact's opt-in.
    await this.prisma.channel_opts
      .deleteMany({ where: { id: optinId, contact_id: contactId } })
      .catch(() => undefined);
    return { success: true };
  }

  /**
   * Opt a contact's number in/out of a workspace channel. Mirrors replyagent's
   * ContactsController::setContactOptin → ContactHelper::optInWhatsapp /
   * ChannelOpt::optOut. A channel_opts row's PRESENCE = opted in; its absence =
   * opted out. The row links the contact's mobile (contactable) to the workspace
   * channel number (modelable = WhatsappNumber / ZapiInstance).
   *
   * Body: { action:'optin'|'optout', channel_type:'whatsapp'|'zapi',
   *         channel:{ id }, phone_number:{ object_id } }
   */
  async optin(workspaceId: bigint, contactId: bigint, data: any) {
    const action = String(data?.action ?? 'optin');
    const channelType = String(data?.channel_type ?? 'whatsapp');
    const channelId =
      data?.channel?.id != null ? BigInt(data.channel.id) : null;
    const mobileId =
      data?.phone_number?.object_id != null
        ? BigInt(data.phone_number.object_id)
        : null;

    if (!channelId || !mobileId) {
      throw new BadRequestException('Missing required data');
    }

    const modelableType =
      channelType === 'zapi'
        ? 'App\\Models\\Zapi\\ZapiInstance'
        : 'App\\Models\\Whatsapp\\WhatsappNumber';
    const MOBILE_CONTACTABLE = 'App\\Models\\Contact\\MobileContact';

    if (action === 'optin') {
      // hasOpted? — match by contact + channel + modelable_id + mobile (skip
      // modelable_type in the lookup: backslash morph-string equality is flaky
      // in this MySQL setup, so we rely on the id pair which is unambiguous).
      const existing = await this.prisma.channel_opts.findFirst({
        where: {
          contact_id: contactId,
          channel: channelType as any,
          modelable_id: channelId,
          contactable_id: mobileId,
        },
      });
      if (!existing) {
        await this.prisma.channel_opts.create({
          data: {
            contact_id: contactId,
            channel: channelType as any,
            modelable_id: channelId,
            modelable_type: modelableType,
            contactable_id: mobileId,
            contactable_type: MOBILE_CONTACTABLE,
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      }
    } else {
      // optout = delete the row (replyagent: ChannelOpt::optOut deletes it).
      await this.prisma.channel_opts
        .deleteMany({
          where: {
            contact_id: contactId,
            channel: channelType as any,
            modelable_id: channelId,
            contactable_id: mobileId,
          },
        })
        .catch(() => undefined);
    }

    // Return the refreshed contact so the FE re-binds optin state (parity with
    // replyagent which returns the ContactResource).
    return await this.getContact(workspaceId, contactId);
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

  /**
   * Global simple search — mirrors replyagent's POST /contact/search/simple.
   * type: first_name | last_name | full_name | id | whatsapp | phone | email | instagram | messenger
   */
  async simpleSearch(workspaceId: bigint, term: string, type: string) {
    const t = term.trim();
    if (!t) return { contacts: [] };

    let contactIds: bigint[] | null = null;

    if (type === 'whatsapp' || type === 'phone') {
      const slug = type === 'whatsapp' ? 'whatsapp' : 'mobile';
      const mobiles = await this.prisma.contact_mobiles.findMany({
        where: {
          ownership_type: 'App\\Models\\Contact',
          full_mobile_number: { contains: t },
          slug,
        },
        select: { ownership_id: true },
        take: 50,
      });
      contactIds = mobiles.map((m) => m.ownership_id);
    } else if (type === 'email') {
      const emails = await this.prisma.contact_emails.findMany({
        where: { email: { contains: t } },
        select: { ownership_id: true },
        take: 50,
      });
      contactIds = emails.map((e) => e.ownership_id);
    } else if (type === 'instagram') {
      const chats = await this.prisma.insta_chats.findMany({
        where: {
          OR: [
            { name: { contains: t } },
            { username: { contains: t } },
          ],
        },
        select: { contact_id: true },
        take: 50,
      });
      contactIds = chats.filter((c) => c.contact_id).map((c) => c.contact_id as bigint);
    } else if (type === 'messenger') {
      const chats = await this.prisma.fb_chats.findMany({
        where: {
          OR: [
            { first_name: { contains: t } },
            { last_name: { contains: t } },
          ],
        },
        select: { contact_id: true },
        take: 50,
      });
      contactIds = chats.filter((c) => c.contact_id).map((c) => c.contact_id as bigint);
    } else if (type === 'support_ticket') {
      const rows = await this.prisma.support_numbers.findMany({
        where: { sn_number: { contains: t } },
        select: { contact_id: true },
        take: 50,
      });
      contactIds = rows.map((r) => r.contact_id);
    }

    const where: any = {
      workspace_id: workspaceId,
      deleted_at: null,
      status: 'ACTIVE',
    };

    if (contactIds !== null) {
      if (contactIds.length === 0) return { contacts: [] };
      where.id = { in: contactIds };
    } else if (type === 'id') {
      try { where.id = BigInt(t); } catch { return { contacts: [] }; }
    } else if (type === 'first_name') {
      where.first_name = { contains: t };
    } else if (type === 'last_name') {
      where.last_name = { contains: t };
    } else {
      where.full_name = { contains: t };
    }

    const contacts = await this.prisma.contacts.findMany({
      where,
      take: 20,
      orderBy: { updated_at: 'desc' },
    });

    return {
      contacts: contacts.map((c) => ({
        id: c.id.toString(),
        full_name: c.full_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unknown',
        first_name: c.first_name,
        last_name: c.last_name,
      })),
    };
  }
}
