import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChargebeeService } from '../billing/chargebee.service';
import { DomainsService } from '../domains/domains.service';
import { S3Service } from '../s3/s3.service';
import { MailerService } from '../mail/mailer.service';
import { buildEmailHtml } from '../mail/email-template';
import * as bcrypt from 'bcrypt';

// Date-only strings (YYYY-MM-DD) need explicit start/end-of-day so a request
// like ?from=2026-05-21&to=2026-05-21 covers the full day, not just midnight.
function parseRangeStart(v: string): Date {
  const d = new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d.setHours(0, 0, 0, 0);
  return d;
}
function parseRangeEnd(v: string): Date {
  const d = new Date(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d.setHours(23, 59, 59, 999);
  return d;
}

@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
    private readonly domainsService: DomainsService,
    private readonly s3: S3Service,
    private readonly mailer: MailerService,
  ) { }

  /** If the value looks like an S3 key (no scheme), return a 1h signed URL; otherwise pass-through. */
  private async toDisplayUrl(value: string | null | undefined): Promise<string> {
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value; // already an absolute URL
    const signed = await this.s3.getSignedUrl(value, 3600);
    return signed || '';
  }

  // ─── Agency Profile & Branding ──────────────────────────────────────

  // ─── Billing Plans (Swich-backed; no Chargebee here) ──────────────────

  /** All active plans + monthly USD price, for the Billing/Plans checkout page. */
  async getBillingPlans() {
    const plans = await this.prisma.billing_plans.findMany({
      where: { status: 'active', deleted_at: null },
      orderBy: { plan_order: 'asc' },
    });
    const prices = await this.prisma.billing_item_prices.findMany({
      where: { itemable_id: { in: plans.map((p) => p.id) }, status: 'active' },
    });
    return plans.map((p) => {
      const price = prices.find((pr) => pr.itemable_id === p.id);
      return { ...p, price_cents: price?.price ?? null, currency_code: price?.currency_code ?? null };
    });
  }

  /** The agency's active plan (for the "Current Plan" badge) — nulls if none. */
  async getCurrentPlan(agencyId: bigint) {
    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, status: { in: ['active', 'in_trial'] as any }, deleted_at: null },
      orderBy: [{ activated_at: 'desc' }],
    });
    if (!subscription?.billing_plan_id) return { subscription: null, plan: null };
    const plan = await this.prisma.billing_plans.findUnique({ where: { id: subscription.billing_plan_id } });
    return { subscription, plan };
  }

  /** Mirrors AuthService's private helper of the same name/shape — a bare
   * domain needs the local dev port appended outside production. */
  private buildTenantUrl(domain: string): string {
    // See the identical comment in AuthService.buildTenantUrl — domains.domain
    // isn't consistently stored bare, so strip any existing scheme first.
    const bareDomain = domain.replace(/^https?:\/\//, '');
    const port = process.env.NODE_ENV === 'production' ? '' : `:${process.env.LOCAL_FRONTEND_PORT || '5173'}`;
    return `https://${bareDomain}${port}`;
  }

  private async getActiveSubscription(agencyId: bigint) {
    return this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, status: { in: ['active', 'in_trial'] as any }, deleted_at: null },
      orderBy: [{ activated_at: 'desc' }],
    });
  }

  /**
   * Cancels the agency's active plan — a deliberate opt-out, distinct from
   * the "no downgrades via checkout" rule (activatePlanFromTransaction).
   * Marks the subscription cancelled rather than deleting it (keeps
   * history); getCurrentPlan() only looks at active/in_trial rows, so once
   * cancelled the agency shows as back on Free automatically — no separate
   * "revert to free" step needed.
   */
  async cancelSubscription(agencyId: bigint) {
    const subscription = await this.getActiveSubscription(agencyId);
    if (!subscription) throw new BadRequestException('No active subscription to cancel.');

    await this.prisma.billing_subscriptions.update({
      where: { id: subscription.id },
      data: { status: 'cancelled', cancelled_at: new Date(), updated_at: new Date() },
    });
    return { success: true };
  }

  private parseCouponCodes(coupons: string | null): string[] {
    return (coupons || '').split(',').map((c) => c.trim()).filter(Boolean);
  }

  /** billing_coupons rows currently applied to the agency's subscription. */
  async getAppliedCoupons(agencyId: bigint) {
    const subscription = await this.getActiveSubscription(agencyId);
    const codes = this.parseCouponCodes(subscription?.coupons ?? null);
    if (!codes.length) return [];
    return this.prisma.billing_coupons.findMany({ where: { coupon_id: { in: codes }, status: 'active' } });
  }

  /**
   * Checkout-time preview — no subscription needed (the agency may not have
   * one yet), just tells the checkout page whether the code is real and
   * what it's worth, so the page can show a discounted price before payment.
   * Doesn't persist anything; applyCoupon() below does that after purchase.
   */
  async validateCoupon(rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const coupon = await this.prisma.billing_coupons.findFirst({ where: { coupon_id: code, status: 'active' } });
    if (!coupon) throw new BadRequestException('That coupon code is invalid or no longer active.');
    return {
      code: coupon.coupon_id,
      name: coupon.invoice_name || coupon.coupon_id,
      discount_percentage: coupon.discount_percentage ? Number(coupon.discount_percentage) : null,
      discount_amount_cents: coupon.discount_amount ? Number(coupon.discount_amount) : null,
    };
  }

  async applyCoupon(agencyId: bigint, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    if (!code) throw new BadRequestException('Enter a coupon code.');

    const coupon = await this.prisma.billing_coupons.findFirst({ where: { coupon_id: code, status: 'active' } });
    if (!coupon) throw new BadRequestException('That coupon code is invalid or no longer active.');

    const subscription = await this.getActiveSubscription(agencyId);
    if (!subscription) throw new BadRequestException('No active subscription to apply a coupon to.');

    const codes = this.parseCouponCodes(subscription.coupons);
    if (codes.includes(code)) throw new BadRequestException('That coupon is already applied.');
    codes.push(code);

    await this.prisma.billing_subscriptions.update({
      where: { id: subscription.id },
      data: { coupons: codes.join(','), updated_at: new Date() },
    });
    return { success: true, coupons: codes };
  }

  async removeCoupon(agencyId: bigint, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const subscription = await this.getActiveSubscription(agencyId);
    if (!subscription) throw new BadRequestException('No active subscription.');

    const codes = this.parseCouponCodes(subscription.coupons).filter((c) => c !== code);
    await this.prisma.billing_subscriptions.update({
      where: { id: subscription.id },
      data: { coupons: codes.join(',') || null, updated_at: new Date() },
    });
    return { success: true, coupons: codes };
  }

  // Per-unit overage price, in cents — only for the two resources whose
  // rate the real pricing page actually states ("$19 each additional
  // workspace" for Ignite, "$16" for Enterprise). Everything else stays a
  // plain usage count rather than a guessed dollar figure.
  private static readonly WORKSPACE_OVERAGE_CENTS: Record<string, number> = {
    'ignite-plan': 1900,
    'enterprise-plan': 1600,
  };

  /**
   * Real usage vs. plan allowance, for the Current Usage modal. Workspaces
   * is the only resource that's genuinely agency-wide (the plan caps total
   * workspaces), so it's the only one with a real dollar overage charge;
   * contacts/agents/AI assistants/channels are capped per-workspace (see
   * createWorkspace), so they're reported as counts only — summing them
   * into one agency-wide "over/under" figure would misrepresent how the
   * limit actually applies.
   */
  async getCurrentUsage(agencyId: bigint) {
    const { plan } = await this.getCurrentPlan(agencyId);

    const workspaces = await this.prisma.workspaces.findMany({
      where: { agency_id: agencyId, deleted_at: null },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);
    const workspacesUsed = workspaces.length;

    const [contactsUsed, aiAssistantsUsed, channelsUsed, agentsUsed] = workspaceIds.length
      ? await Promise.all([
          this.prisma.contacts.count({ where: { workspace_id: { in: workspaceIds }, deleted_at: null } }),
          this.prisma.ai_agents.count({ where: { workspace_id: { in: workspaceIds } } }),
          this.prisma.wa_accounts.count({ where: { workspace_id: { in: workspaceIds }, deleted_at: null } }),
          this.prisma.users.count({ where: { modelable_id: { in: workspaceIds }, modelable_type: 'App\\Models\\Workspace' } }),
        ])
      : [0, 0, 0, 0];

    const includedWorkspaces = plan?.maximum_workspaces ?? workspacesUsed;
    const extraWorkspaces = Math.max(0, workspacesUsed - includedWorkspaces);
    const overageRateCents = plan ? (AgencyService.WORKSPACE_OVERAGE_CENTS[plan.item_id] ?? 0) : 0;
    const planPriceCents = plan
      ? (await this.prisma.billing_item_prices.findFirst({ where: { itemable_id: plan.id, status: 'active' } }))?.price ?? null
      : null;

    const subtotalCents = (planPriceCents ?? 0) + extraWorkspaces * overageRateCents;

    // Real coupons (billing_coupons, applied via applyCoupon()) — each knocks
    // a % off the subtotal independently (not compounded), matching how the
    // UI has always listed them as separate line-item discounts.
    const appliedCoupons = await this.getAppliedCoupons(agencyId);
    const coupons = appliedCoupons.map((c) => ({
      code: c.coupon_id,
      name: c.invoice_name || c.coupon_id,
      discount_percentage: c.discount_percentage ? Number(c.discount_percentage) : null,
      discount_cents: c.discount_percentage
        ? Math.round(subtotalCents * (Number(c.discount_percentage) / 100))
        : Number(c.discount_amount ?? 0),
    }));
    const discountCents = coupons.reduce((sum, c) => sum + c.discount_cents, 0);

    return {
      plan: plan ? { item_id: plan.item_id, name: plan.external_name, price_cents: planPriceCents } : null,
      workspaces: { used: workspacesUsed, included: includedWorkspaces, extra: extraWorkspaces, overage_cents: extraWorkspaces * overageRateCents },
      contacts: { used: contactsUsed, included_per_workspace: plan?.maximum_contacts ?? null },
      agents: { used: agentsUsed, included_per_workspace: plan?.free_agents ?? null },
      ai_assistants: { used: aiAssistantsUsed, included_per_workspace: plan?.free_ai_agents ?? null },
      channels: { used: channelsUsed, included_per_workspace: plan?.free_channels ?? null },
      subtotal_cents: subtotalCents,
      coupons,
      discount_cents: discountCents,
      total_cents: Math.max(0, subtotalCents - discountCents),
    };
  }

  async getAgency(agencyId: bigint) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: agencyId, brandable_type: 'App\\Models\\Agency' }
    });

    const address = await this.prisma.addresses.findFirst({
      where: {
        addressable_id: agencyId,
        addressable_type: 'App\\Models\\Agency',
      },
    });

    const mobile = await this.prisma.contact_mobiles.findFirst({
      where: { modelable_type: 'App\\Models\\Agency', modelable_id: agencyId },
      select: { full_mobile_number: true },
    });

    // Resolve all 4 logo URLs + favicon → signed URLs.
    // Replyagent Branding accessor parity: logo_light, logo_light_small, logo_dark, logo_dark_small, favicon.
    const resolveById = async (id: bigint | null | undefined): Promise<string> => {
      if (!id) return '';
      const m = await this.prisma.media_gallery.findUnique({ where: { id } });
      return this.toDisplayUrl(m?.file_url);
    };
    let logoUrl = '';
    let logoSmallUrl = '';
    let logoDarkUrl = '';
    let logoDarkSmallUrl = '';
    let faviconUrl = '';
    if (branding) {
      [logoUrl, logoSmallUrl, logoDarkUrl, logoDarkSmallUrl, faviconUrl] = await Promise.all([
        resolveById(branding.mid_logo_light),
        resolveById(branding.mid_logo_light_small),
        resolveById(branding.mid_logo_dark),
        resolveById(branding.mid_logo_dark_small),
        resolveById(branding.favicon_media_id),
      ]);
    }

    return {
      success: true,
      agency: {
        ...this.serialize(agency),
        branding: branding ? {
          ...this.serialize(branding),
          // Replyagent parity field names + legacy aliases for backward compatibility.
          logo_light: logoUrl,
          logo_light_small: logoSmallUrl,
          logo_dark: logoDarkUrl,
          logo_dark_small: logoDarkSmallUrl,
          logo: logoUrl,            // legacy alias (= logo_light)
          logo_small: logoSmallUrl, // legacy alias (= logo_light_small)
          favicon: faviconUrl,
        } : null,
        address: address ? this.serialize(address) : null,
        phone: mobile?.full_mobile_number ?? '',
      }
    };
  }


  async updateAgency(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const updated = await this.prisma.agencies.update({
      where: { id: agencyId },
      data: {
        name: data.name,
        email: data.email,
        notification_email: data.notification_email,
        timezone: data.timezone,
        notification_language: data.notification_language,
        tax_id: data.tax_id,
        vat: data.vat,
        billing_company: data.billing_company,
        billing_person: data.billing_person,
      },
    });

    // Sync with Chargebee
    if (agency.customer_id) {
      const nameArr = (data.billing_person || '').split(' ');
      const firstName = nameArr[0];
      const lastName = nameArr.slice(1).join(' ');

      try {
        await this.chargebee.updateCustomer(agency.customer_id, {
          first_name: firstName,
          last_name: lastName,
          company: data.billing_company,
          email: data.email || agency.email,
          cf_tax_id: data.tax_id,
          cf_vat_number: data.vat,
        });
      } catch (err) {
        this.logger.error(`Chargebee Sync Error: ${err.message}`);
      }
    }

    // GAP 5: persist phone into contact_mobiles
    if (data.phone) {
      const country = data.phone_country_iso2
        ? await this.prisma.countries.findFirst({ where: { iso2: String(data.phone_country_iso2) }, select: { id: true, phone_code: true } })
        : null;
      const phoneRow = {
        full_mobile_number: String(data.phone),
        mobile_number: String(data.phone),
        national_mobile_number: String(data.phone),
        country_code: country?.phone_code ?? null,
        country_id: country?.id ?? 1n,
        slug: 'mobile',
        type: 'agency',
        is_primary: 1,
        updated_at: new Date(),
      };
      const existingMobile = await this.prisma.contact_mobiles.findFirst({
        where: { modelable_type: 'App\\Models\\Agency', modelable_id: agencyId },
        select: { id: true },
      });
      if (existingMobile) {
        await this.prisma.contact_mobiles.update({ where: { id: existingMobile.id }, data: phoneRow });
      } else {
        await this.prisma.contact_mobiles.create({
          data: {
            modelable_type: 'App\\Models\\Agency',
            modelable_id: agencyId,
            ownership_type: 'App\\Models\\Agency',
            ownership_id: agencyId,
            ...phoneRow,
            created_at: new Date(),
          },
        });
      }
    }

    await this.logAgencyEvent(agencyId, 'agency_updated', data.user_id, 'App\\Models\\Agency', agencyId, data);

    return { success: true, agency: this.serialize(updated) };
  }

  async updateBillingAddress(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({ where: { id: agencyId } });
    if (!agency) throw new NotFoundException('Agency not found');

    // Billing Details save covers company/person/tax fields too — this was
    // previously silently dropped because only the address half was ever
    // persisted here, even though the frontend sends everything together.
    await this.prisma.agencies.update({
      where: { id: agencyId },
      data: {
        billing_company: data.billing_company,
        billing_person: data.billing_person,
        tax_id: data.tax_id,
        vat: data.vat,
      },
    });

    // GAP 1+2: fix upsert — find by agency first, then update or create; persist country_iso2
    const addr = data.address ?? {};
    const addressFields = {
      street: addr.street ?? null,
      city: addr.city ?? null,
      state: addr.state ?? null,
      zip: addr.zip ?? null,
      country_iso2: addr.country_iso2 ?? null,
      updated_at: new Date(),
    };
    const existingAddress = await this.prisma.addresses.findFirst({
      where: { addressable_id: agencyId, addressable_type: 'App\\Models\\Agency' },
      select: { id: true },
    });
    if (existingAddress) {
      await this.prisma.addresses.update({ where: { id: existingAddress.id }, data: addressFields });
    } else {
      await this.prisma.addresses.create({
        data: {
          addressable_id: agencyId,
          addressable_type: 'App\\Models\\Agency',
          ...addressFields,
          created_at: new Date(),
        },
      });
    }

    await this.logAgencyEvent(
      agencyId,
      'billing_address_updated',
      data.user_id ?? 0n,
      'App\\Models\\Agency',
      agencyId,
      { city: data.address?.city, country: data.address?.country_iso2 },
    );

    return { success: true };
  }

  async updateBranding(agencyId: bigint, data: any) {
    // 1. Fetch or create branding record
    let branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: agencyId, brandable_type: 'App\\Models\\Agency' }
    });

    if (!branding) {
      branding = await this.prisma.brandings.create({
        data: {
          brandable_id: agencyId,
          brandable_type: 'App\\Models\\Agency',
          color: data.color || '#149f8f',
        }
      });
    }

    const updateData: any = {};
    if (data.color !== undefined) updateData.color = data.color;

    // Resolve a media reference to a media_gallery.id (replyagent Branding parity).
    // Accepts: explicit numeric/bigint media_id; S3 key (e.g. "gallery/a1/abc.jpg"); a signed URL
    // whose URL.pathname is the S3 key. Returns null to clear the slot.
    const resolveMediaId = async (
      val: string | number | bigint | null | undefined,
      objectName: string,
    ): Promise<bigint | null> => {
      if (val === null || val === undefined || val === '') return null;

      // numeric id (id or bigint) → trust it
      if (typeof val === 'number' || typeof val === 'bigint') return BigInt(val);
      if (/^\d+$/.test(String(val))) return BigInt(String(val));

      // Normalise: if it's a presigned URL, strip the query + scheme to the bucket path.
      let key = String(val);
      try {
        if (/^https?:\/\//i.test(key)) {
          const u = new URL(key);
          key = u.pathname.replace(/^\//, '');
        }
      } catch {
        /* leave as-is */
      }

      let media = await this.prisma.media_gallery.findFirst({
        where: { OR: [{ file_url: key }, { file_path: key }] },
      });

      if (!media) {
        media = await this.prisma.media_gallery.create({
          data: {
            modelable_id: agencyId,
            modelable_type: 'App\\Models\\Agency',
            file_url: key,
            file_path: key,
            object_name: objectName.slice(0, 100),
            media_type: 'IMAGE',
            object_status: 'AVAILABLE',
          },
        });
      }
      return media.id;
    };

    // Accept both replyagent-parity field names and legacy aliases.
    if (data.logo_light !== undefined) {
      updateData.mid_logo_light = await resolveMediaId(data.logo_light, 'Agency Logo Light');
    } else if (data.logo !== undefined) {
      updateData.mid_logo_light = await resolveMediaId(data.logo, 'Agency Logo Light');
    }

    if (data.logo_light_small !== undefined) {
      updateData.mid_logo_light_small = await resolveMediaId(data.logo_light_small, 'Agency App Icon Light');
    } else if (data.logo_small !== undefined) {
      updateData.mid_logo_light_small = await resolveMediaId(data.logo_small, 'Agency App Icon Light');
    }

    if (data.logo_dark !== undefined) {
      updateData.mid_logo_dark = await resolveMediaId(data.logo_dark, 'Agency Logo Dark');
    }

    if (data.logo_dark_small !== undefined) {
      updateData.mid_logo_dark_small = await resolveMediaId(data.logo_dark_small, 'Agency App Icon Dark');
    }

    if (data.favicon !== undefined) {
      updateData.favicon_media_id = await resolveMediaId(data.favicon, 'Agency Favicon');
    }

    const updatedBranding = await this.prisma.brandings.update({
      where: { id: branding.id },
      data: updateData,
    });

    // 3. Update Agency slug/domain if provided
    if (data.slug !== undefined) {
      await this.prisma.agencies.update({
        where: { id: agencyId },
        data: {
          slug: data.slug,
        }
      });
    }

    await this.logAgencyEvent(
      agencyId,
      'branding_updated',
      data.user_id ?? 0n,
      'App\\Models\\Agency',
      agencyId,
      { color: data.color },
    );

    return { success: true, branding: this.serialize(updatedBranding) };
  }

  // ─── Workspace Management ───────────────────────────────────────────

  async getWorkspaces(agencyId: bigint) {
    const workspaces = await this.prisma.workspaces.findMany({
      where: { agency_id: agencyId, deleted_at: null },
      orderBy: { created_at: 'desc' }
    });
    return { success: true, workspaces: this.serialize(workspaces) };
  }


  async workspaceCheckout(agencyId: bigint, data: any) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });

    if (!agency) throw new NotFoundException('Agency not found');

    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, deleted_at: null },
    });

    if (!subscription || !subscription.billing_plan_id) throw new BadRequestException('Subscription or Plan not found');

    const plan = await this.prisma.billing_plans.findUnique({
      where: { id: subscription.billing_plan_id },
    });

    if (!plan) throw new BadRequestException('Plan not found');

    const totalWorkspaces = await this.prisma.workspaces.count({
      where: { agency_id: agencyId, deleted_at: null },
    });

    if (totalWorkspaces >= plan.maximum_workspaces) {
      throw new BadRequestException('Workspace limit reached');
    }

    // Estimation logic
    const subscriptionItems: any[] = [];
    const extraWorkspaces = totalWorkspaces + 1 - plan.free_workspaces;

    if (extraWorkspaces > 0) {
      // Assuming you have the Price ID for extra workspaces
      subscriptionItems.push({
        item_price_id: process.env.BILLING_WORKSPACE_ADDON_PRICE_ID,
        quantity: extraWorkspaces,
      });
    }

    try {
      const estimate = await this.chargebee.estimateUpdateSubscriptionForItems({
        subscription: { id: subscription.subscription_id },
        subscription_items: subscriptionItems,
      });
      return { success: true, estimate };
    } catch (err) {
      throw new BadRequestException(`Estimation failed: ${err.message}`);
    }
  }

  async createWorkspace(agencyId: bigint, data: any, creatorId: bigint) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId },
    });

    if (!agency) throw new NotFoundException('Agency not found');

    // GAP 1: name uniqueness per agency
    const nameExists = await this.prisma.workspaces.findFirst({
      where: { agency_id: agencyId, name: data.name, deleted_at: null },
      select: { id: true },
    });
    if (nameExists) throw new BadRequestException('A workspace with this name already exists in your agency.');

    // GAP 2: subdomain/slug uniqueness across all workspaces
    const slugExists = await this.prisma.workspaces.findFirst({
      where: { slug: data.slug, deleted_at: null },
      select: { id: true },
    });
    if (slugExists) throw new BadRequestException('This subdomain is already taken. Please choose a different one.');

    // GAP 3: agents_limit guard
    if (data.allow_agents && (data.agents_limit ?? 4) <= 0) {
      throw new BadRequestException('Agent limit must be greater than 0 when agents are enabled.');
    }

    // Must match getActiveSubscription's status filter (active/in_trial) — an
    // unfiltered lookup can return a stale cancelled row that still carries
    // its old billing_plan_id, silently reinstating limits from a plan the
    // agency isn't actually on anymore.
    const subscription = await this.getActiveSubscription(agencyId);

    const plan = subscription && subscription.billing_plan_id
      ? await this.prisma.billing_plans.findUnique({
        where: { id: subscription.billing_plan_id },
      })
      : null;

    // Plan-level workspace cap — agencies without a resolvable plan/subscription
    // aren't blocked (matches PlanFeaturesService's permissive-default stance).
    if (plan) {
      const totalWorkspaces = await this.prisma.workspaces.count({
        where: { agency_id: agencyId, deleted_at: null },
      });
      if (totalWorkspaces >= plan.maximum_workspaces) {
        throw new BadRequestException('Workspace limit reached');
      }
    }

    // Plan-level caps on per-workspace resources — same shape as the
    // workspace-count check above: exceeding the plan's allowance blocks the
    // request with an explicit error, it doesn't get silently clamped. No
    // plan/subscription skips these checks (pre-existing defaults apply).
    const enforcePlanLimit = (label: string, requested: number | undefined, planAllowance: number) => {
      if (requested != null && requested > planAllowance) {
        throw new BadRequestException(`${label} exceeds your plan's limit of ${planAllowance}.`);
      }
      return requested ?? planAllowance;
    };

    let agentsLimit = data.agents_limit ?? 4;
    let maximumContacts = data.maximum_contacts ?? 0;
    let chatgptAssistantLimit = data.chatgpt_assistant_limit ?? 10;
    let whatsappChannelsLimit = data.whatsapp_channels_limit ?? 1;
    let instagramChannelsLimit = data.instagram_channels_limit ?? 1;
    let facebookChannelsLimit = data.facebook_channels_limit ?? 1;
    let allowBranding = data.allow_branding ?? false;

    if (plan) {
      agentsLimit = enforcePlanLimit('Agent limit', data.agents_limit, plan.free_agents);
      // Every real plan defines a contacts cap (no "unlimited" tier), so the
      // workspace is always contact-limited once a plan resolves — default
      // to the plan's own allowance rather than 0, which enforceContactsLimit
      // (contacts.service.ts) treats as "no cap" and would silently disable
      // enforcement entirely.
      maximumContacts = enforcePlanLimit(
        'Contact limit',
        data.limited_contacts ? data.maximum_contacts : plan.maximum_contacts,
        plan.maximum_contacts,
      );
      chatgptAssistantLimit = enforcePlanLimit('AI assistant limit', data.chatgpt_assistant_limit, plan.free_ai_agents);
      whatsappChannelsLimit = enforcePlanLimit('WhatsApp channel limit', data.whatsapp_channels_limit, plan.free_channels);
      instagramChannelsLimit = enforcePlanLimit('Instagram channel limit', data.instagram_channels_limit, plan.free_channels);
      facebookChannelsLimit = enforcePlanLimit('Facebook channel limit', data.facebook_channels_limit, plan.free_channels);
      if (data.allow_branding && !plan.allow_branding) {
        throw new BadRequestException("White-label branding isn't included in your plan.");
      }
    }

    const workspace = await this.prisma.$transaction(async (tx) => {
      // 1. Create Workspace
      // GAP 2's pre-check above only sees non-deleted workspaces, but the DB's
      // `workspaces_slug_unique` constraint applies to every row regardless of
      // deleted_at — a soft-deleted workspace can still hold a slug the
      // pre-check thinks is free. Catch that race here instead of letting a
      // raw P2002 crash the request.
      let ws;
      try {
        ws = await tx.workspaces.create({
          data: {
            name: data.name,
            slug: data.slug,
            agency_id: agencyId,
            creator_id: creatorId,
            agency_agent_id: data.agent_id ? BigInt(data.agent_id) : null,
            timezone: data.timezone || agency.timezone || 'UTC',
            status: 'ACTIVE',
            created_at: new Date(),
            updated_at: new Date(),
            contacts_counter: 0,
            allow_branding: allowBranding,
            allow_support: data.allow_support ?? false,
            allow_agents: data.allow_agents ?? true,
            agents_limit: agentsLimit,
            limited_contacts: plan ? true : (data.limited_contacts ?? false),
            maximum_contacts: maximumContacts,
            chatgpt_assistant_limit: chatgptAssistantLimit,
            whatsapp_channels_limit: whatsappChannelsLimit,
            instagram_channels_limit: instagramChannelsLimit,
            facebook_channels_limit: facebookChannelsLimit,
            telegram_channels_limit: data.telegram_channels_limit ?? 1,
            twilio_channels_limit: data.twilio_channels_limit ?? 1,
            zapi_channels_limit: data.zapi_channels_limit ?? 0,
            webchat_channels_limit: data.webchat_channels_limit ?? 0,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException('This subdomain is already taken. Please choose a different one.');
        }
        throw err;
      }

      // 2. If an agency agent is assigned, mirror them as a workspace user row so they
      //    can later log in at the workspace's subdomain (login flow filters by
      //    modelable_id + modelable_type matching the host's site_domain).
      //    Pattern mirrors gateway: separate user row, agency_user_id cross-links back.
      //    PENDING + no password — the agent gets an invite email (sent after the
      //    transaction commits, see below) and sets their own password for THIS
      //    workspace login via the existing accept-invitation flow, instead of
      //    silently reusing their agency-level password hash.
      let inviteUser: { id: bigint; email: string } | null = null;
      if (data.agent_id) {
        const agentId = BigInt(data.agent_id);
        const agencyUser = await tx.users.findFirst({
          where: {
            id: agentId,
            modelable_type: 'App\\Models\\Agency',
            modelable_id: agencyId,
            status: 'ACTIVE',
          },
        });
        if (agencyUser) {
          const existing = await tx.users.findFirst({
            where: {
              modelable_type: 'App\\Models\\Workspace',
              modelable_id: ws.id,
              agency_user_id: agencyUser.id,
            },
          });
          if (!existing) {
            const created = await tx.users.create({
              data: {
                first_name: agencyUser.first_name,
                last_name: agencyUser.last_name,
                full_name: agencyUser.full_name,
                email: agencyUser.email,
                password: '',
                modelable_type: 'App\\Models\\Workspace',
                modelable_id: ws.id,
                agency_user_id: agencyUser.id,
                is_owner: true,
                locale: agencyUser.locale,
                timezone: agencyUser.timezone,
                status: 'PENDING',
                creator_id: creatorId,
                created_at: new Date(),
                updated_at: new Date(),
              },
            });
            inviteUser = { id: created.id, email: created.email };
          }
        }
      }

      // 3. Chargebee Sync — DISABLED (commented, not deleted, in case
      // Chargebee gets configured later). This project currently uses Swich
      // + its own billing_plans/billing_subscriptions tables (see
      // activatePlanFromTransaction in swich.service.ts), not Chargebee.
      // Chargebee is never configured here (CHARGEBEE_SITE/API_KEY unset in
      // .env), so ChargebeeService.client is null and this call always threw
      // "Cannot read properties of null (reading 'subscription')" — inside
      // this $transaction, that exception rolled back the whole workspace
      // creation. It only started firing once billing_subscriptions actually
      // had rows (previously `subscription` was always null, so this branch
      // never ran) — a pre-existing dormant bug, not something introduced
      // today, just newly triggered by real subscription data existing.
      //
      // if (subscription && plan) {
      //   const totalWs = await tx.workspaces.count({
      //     where: { agency_id: agencyId, deleted_at: null },
      //   });
      //   const extra = totalWs - plan.free_workspaces;
      //
      //   if (extra > 0) {
      //     await this.chargebee.updateSubscriptionForItems(
      //       subscription.subscription_id,
      //       {
      //         subscription_items: [
      //           {
      //             item_price_id: process.env.BILLING_WORKSPACE_ADDON_PRICE_ID,
      //             quantity: extra,
      //           },
      //         ],
      //       },
      //     );
      //   }
      // }

      return { ws, inviteUser };
    });

    // 3. Domain creation — ROOT_DOMAIN, same as every other domain created in
    // this codebase (signup's agency/default-workspace domains in
    // auth.service.ts). The old ACCOUNTS_DOMAIN var below is unset anywhere
    // in .env, so it was silently falling back to the production root
    // ("agentawk.com") — every manually-created workspace got a domain that
    // can't resolve locally. Left commented (not deleted) — testing the
    // ROOT_DOMAIN swap before removing the old line for good.
    // const domainRoot = process.env.ACCOUNTS_DOMAIN || 'agentawk.com';
    const rootDomain = process.env.ROOT_DOMAIN || 'agentawk.com';
    await this.domainsService.addCustomDomain(
      workspace.ws.id,
      'WORKSPACE',
      data.slug,
      rootDomain,
      creatorId,
    );

    if (workspace.inviteUser) {
      const invitationId = Buffer.from(workspace.inviteUser.id.toString()).toString('base64');
      // The invited workspace's OWN subdomain, not the generic app URL — the
      // tenant is already known from the invite, so this lands the user
      // straight on that workspace's login after they set a password,
      // instead of the ambiguous "Find Account" flow (see buildTenantUrl).
      // Old generic-URL version kept commented for comparison/rollback:
      // const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const frontendUrl = this.buildTenantUrl(`${data.slug}.${rootDomain}`);
      const inviteLink = `${frontendUrl}/accept-invitation?invitation_id=${invitationId}`;
      this.mailer
        .sendMail({
          to: workspace.inviteUser.email,
          subject: `Set your password for ${workspace.ws.name}`,
          html: buildEmailHtml({
            heading: "You've been assigned a workspace",
            bodyHtml: `<p style="margin:0">Click below to set your password and log in to <b>${workspace.ws.name}</b>.</p>`,
            ctaText: 'Set password',
            ctaUrl: inviteLink,
            footerHtml: `If the button doesn't work, copy this link: ${inviteLink}`,
          }),
          text: `You've been assigned to workspace "${workspace.ws.name}". Set your password: ${inviteLink}`,
        })
        .catch((err) => this.logger.warn(`Failed to send workspace invite email to ${workspace.inviteUser?.email}: ${err?.message ?? err}`));
    }

    await this.logAgencyEvent(agencyId, 'workspace_created', creatorId, 'App\\Models\\Workspace', workspace.ws.id, {
      workspace_name: workspace.ws.name,
    });

    return { success: true, workspace: this.serialize(workspace.ws) };
  }

  async updateWorkspace(workspaceId: bigint, agencyId: bigint, data: any, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace)
      throw new NotFoundException('Workspace not found in this agency');

    // GAP 4: name uniqueness on update (exclude current workspace)
    if (data.name && data.name !== workspace.name) {
      const nameExists = await this.prisma.workspaces.findFirst({
        where: { agency_id: agencyId, name: data.name, deleted_at: null, NOT: { id: workspaceId } },
        select: { id: true },
      });
      if (nameExists) throw new BadRequestException('A workspace with this name already exists in your agency.');
    }

    // GAP 3: agents_limit guard on update
    const willAllowAgents = data.allow_agents ?? workspace.allow_agents;
    const willAgentsLimit = data.agents_limit ?? Number(workspace.agents_limit);
    if (willAllowAgents && willAgentsLimit <= 0) {
      throw new BadRequestException('Agent limit must be greater than 0 when agents are enabled.');
    }

    // Same plan-level caps as createWorkspace — editing a workspace can't be
    // used to raise a limit past what the agency's plan allows. Only fields
    // actually present in this update are validated — an unrelated edit
    // (e.g. renaming the workspace) never fails because some other field was
    // already over a plan the agency has since downgraded to.
    // Same status-filtered lookup as createWorkspace — see comment there.
    const subscriptionForUpdate = await this.getActiveSubscription(agencyId);
    const planForUpdate = subscriptionForUpdate?.billing_plan_id
      ? await this.prisma.billing_plans.findUnique({ where: { id: subscriptionForUpdate.billing_plan_id } })
      : null;
    // Only an actual INCREASE past the plan's allowance is blocked. Plenty of
    // existing workspaces already sit above their plan (created before limits
    // were enforced at all, or after the agency moved to a smaller plan), and
    // the edit form posts EVERY field back on every save — even when the user
    // only renamed the workspace. Rejecting an unchanged over-limit value
    // would therefore make those workspaces permanently un-editable. So
    // grandfathered values may be kept or lowered, never raised.
    const enforcePlanLimitOnUpdate = (label: string, requested: number | undefined, current: number, planAllowance: number) => {
      if (requested != null && requested > planAllowance && requested > current) {
        throw new BadRequestException(`${label} exceeds your plan's limit of ${planAllowance}.`);
      }
      return requested ?? current;
    };
    // Same grandfathering rule as the numeric limits above: only block
    // TURNING branding on, not re-saving a workspace that already has it.
    if (planForUpdate && data.allow_branding && !planForUpdate.allow_branding && !workspace.allow_branding) {
      throw new BadRequestException("White-label branding isn't included in your plan.");
    }

    // Agent reassignment (agency_agent_id holds the agency-level user id).
    const oldAgentId = workspace.agency_agent_id;
    const newAgentId = data.agent_id ? BigInt(data.agent_id) : null;
    const agentChanged = String(oldAgentId ?? '') !== String(newAgentId ?? '');

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Persist all editable fields. `?? existing` keeps the current value
      //    when a field isn't supplied, so a partial update never wipes data.
      const ws = await tx.workspaces.update({
        where: { id: workspaceId },
        data: {
          name: data.name ?? workspace.name,
          timezone: data.timezone ?? workspace.timezone,
          agency_agent_id: newAgentId,
          allow_branding: data.allow_branding ?? workspace.allow_branding,
          allow_support: data.allow_support ?? workspace.allow_support,
          allow_agents: data.allow_agents ?? workspace.allow_agents,
          agents_limit: planForUpdate ? enforcePlanLimitOnUpdate('Agent limit', data.agents_limit, Number(workspace.agents_limit), planForUpdate.free_agents) : (data.agents_limit ?? workspace.agents_limit),
          limited_contacts: planForUpdate ? true : (data.limited_contacts ?? workspace.limited_contacts),
          maximum_contacts: planForUpdate ? enforcePlanLimitOnUpdate('Contact limit', data.maximum_contacts, Number(workspace.maximum_contacts), planForUpdate.maximum_contacts) : (data.maximum_contacts ?? workspace.maximum_contacts),
          chatgpt_assistant_limit: planForUpdate ? enforcePlanLimitOnUpdate('AI assistant limit', data.chatgpt_assistant_limit, Number(workspace.chatgpt_assistant_limit), planForUpdate.free_ai_agents) : (data.chatgpt_assistant_limit ?? workspace.chatgpt_assistant_limit),
          whatsapp_channels_limit: planForUpdate ? enforcePlanLimitOnUpdate('WhatsApp channel limit', data.whatsapp_channels_limit, Number(workspace.whatsapp_channels_limit), planForUpdate.free_channels) : (data.whatsapp_channels_limit ?? workspace.whatsapp_channels_limit),
          instagram_channels_limit: planForUpdate ? enforcePlanLimitOnUpdate('Instagram channel limit', data.instagram_channels_limit, Number(workspace.instagram_channels_limit), planForUpdate.free_channels) : (data.instagram_channels_limit ?? workspace.instagram_channels_limit),
          facebook_channels_limit: planForUpdate ? enforcePlanLimitOnUpdate('Facebook channel limit', data.facebook_channels_limit, Number(workspace.facebook_channels_limit), planForUpdate.free_channels) : (data.facebook_channels_limit ?? workspace.facebook_channels_limit),
          telegram_channels_limit: data.telegram_channels_limit ?? workspace.telegram_channels_limit,
          twilio_channels_limit: data.twilio_channels_limit ?? workspace.twilio_channels_limit,
          zapi_channels_limit: data.zapi_channels_limit ?? workspace.zapi_channels_limit,
          webchat_channels_limit: data.webchat_channels_limit ?? workspace.webchat_channels_limit,
          updated_at: new Date(),
        },
      });

      // 2. If the assigned agent changed, re-sync the cross-link workspace-user
      //    (mirrors gateway): remove the old agent's mirrored row, add the new one
      //    so the new agent can log in at the workspace subdomain.
      if (agentChanged) {
        if (oldAgentId) {
          await tx.users.deleteMany({
            where: {
              modelable_type: 'App\\Models\\Workspace',
              modelable_id: workspaceId,
              agency_user_id: oldAgentId,
            },
          });
        }
        if (newAgentId) {
          const agencyUser = await tx.users.findFirst({
            where: {
              id: newAgentId,
              modelable_type: 'App\\Models\\Agency',
              modelable_id: agencyId,
              status: 'ACTIVE',
            },
          });
          if (agencyUser) {
            const existing = await tx.users.findFirst({
              where: {
                modelable_type: 'App\\Models\\Workspace',
                modelable_id: workspaceId,
                agency_user_id: agencyUser.id,
              },
            });
            if (!existing) {
              await tx.users.create({
                data: {
                  first_name: agencyUser.first_name,
                  last_name: agencyUser.last_name,
                  full_name: agencyUser.full_name,
                  email: agencyUser.email,
                  password: agencyUser.password,
                  modelable_type: 'App\\Models\\Workspace',
                  modelable_id: workspaceId,
                  agency_user_id: agencyUser.id,
                  is_owner: true,
                  locale: agencyUser.locale,
                  timezone: agencyUser.timezone,
                  status: 'ACTIVE',
                  creator_id: actorId,
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              });
            }
          }
        }
      }

      return ws;
    });

    await this.logAgencyEvent(agencyId, 'workspace_updated', actorId, 'App\\Models\\Workspace', workspaceId, {
      workspace_name: updated.name,
    });

    return { success: true, workspace: this.serialize(updated) };
  }

  async suspendWorkspace(workspaceId: bigint, agencyId: bigint, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
      select: { name: true },
    });
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { status: 'SUSPENDED' },
    });
    if (updated.count > 0) {
      await this.logAgencyEvent(agencyId, 'workspace_suspended', actorId, 'App\\Models\\Workspace', workspaceId, {
        workspace_name: workspace?.name,
      });
    }
    return { success: updated.count > 0 };
  }

  async activateWorkspace(workspaceId: bigint, agencyId: bigint, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
      select: { name: true },
    });
    const updated = await this.prisma.workspaces.updateMany({
      where: { id: workspaceId, agency_id: agencyId },
      data: { status: 'ACTIVE' },
    });
    if (updated.count > 0) {
      await this.logAgencyEvent(agencyId, 'workspace_activated', actorId, 'App\\Models\\Workspace', workspaceId, {
        workspace_name: workspace?.name,
      });
    }
    return { success: updated.count > 0 };
  }

  /**
   * PERMANENT hard-delete of a workspace and (almost) everything it owns.
   * Replaces the old soft-delete (`deleted_at`) behaviour — every
   * workspace-scoped row across the schema is purged inside one big
   * transaction, then the `workspaces` row itself is deleted.
   *
   * Deliberately excluded from the purge (stakeholder decision):
   *  - `audit_logs` — the workspace's own audit trail survives the delete.
   *  - `agency_logs` — has no `workspace_id` column, never touched here;
   *    the `logAgencyEvent` call below writes the "workspace_deleted" entry
   *    into it AFTER the transaction commits, which is exactly why it's
   *    safe even though the workspace row no longer exists by then.
   *
   * `bundles` gets a safety check: a bundle owned by this workspace that
   * another workspace has downloaded/shared is left in place (collected
   * into `skippedBundles`) instead of being deleted out from under them.
   *
   * `media_gallery` rows are captured (id/file_path/file_url) before
   * deletion into `mediaToCleanup`, for a future S3 object-cleanup job —
   * actual S3 deletion is NOT performed here.
   */
  async deleteWorkspace(workspaceId: bigint, agencyId: bigint, actorId: bigint = 0n) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
      select: { name: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found in this agency');

    const skippedBundles: { id: string; name: string }[] = [];
    const mediaToCleanup: { id: string; file_path: string | null; file_url: string | null }[] = [];

    await this.prisma.$transaction(async (tx) => {
      // ── WhatsApp ──────────────────────────────────────────────────────
      const waAccounts = await tx.wa_accounts.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const waAccountIds = waAccounts.map((a) => a.id);
      if (waAccountIds.length) {
        const waChats = await tx.wa_chats.findMany({ where: { wa_account_id: { in: waAccountIds } }, select: { id: true } });
        const waChatIds = waChats.map((c) => c.id);
        if (waChatIds.length) await tx.wa_messages.deleteMany({ where: { wa_chat_id: { in: waChatIds } } });
        await tx.wa_chats.deleteMany({ where: { wa_account_id: { in: waAccountIds } } });
        // wa_templates.wa_account_id is stored as String, not BigInt — cast.
        await tx.wa_templates.deleteMany({ where: { wa_account_id: { in: waAccountIds.map(String) } } });
        await tx.wa_phone_numbers.deleteMany({ where: { wa_account_id: { in: waAccountIds } } });
      }
      await tx.wa_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.wa_accounts.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Instagram / Messenger (insta_pages serves both platforms) ──────
      const instaPages = await tx.insta_pages.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const instaPageIds = instaPages.map((p) => p.id);
      if (instaPageIds.length) {
        const instaChats = await tx.insta_chats.findMany({ where: { insta_page_id: { in: instaPageIds } }, select: { id: true } });
        const instaChatIds = instaChats.map((c) => c.id);
        if (instaChatIds.length) await tx.insta_messages.deleteMany({ where: { insta_chat_id: { in: instaChatIds } } });
        await tx.insta_chats.deleteMany({ where: { insta_page_id: { in: instaPageIds } } });
        await tx.insta_page_users.deleteMany({ where: { insta_page_id: { in: instaPageIds } } });
        await tx.insta_features.deleteMany({ where: { insta_page_id: { in: instaPageIds } } });
      }
      await tx.insta_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.insta_pages.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Facebook (legacy, separate fb_pages table) ─────────────────────
      const fbPages = await tx.fb_pages.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const fbPageIds = fbPages.map((p) => p.id);
      if (fbPageIds.length) {
        const fbChats = await tx.fb_chats.findMany({ where: { fb_page_id: { in: fbPageIds } }, select: { id: true } });
        const fbChatIds = fbChats.map((c) => c.id);
        if (fbChatIds.length) await tx.fb_messages.deleteMany({ where: { fb_chat_id: { in: fbChatIds } } });
        const fbOtnRequests = await tx.fb_otn_requests.findMany({ where: { fb_page_id: { in: fbPageIds } }, select: { id: true } });
        const fbOtnRequestIds = fbOtnRequests.map((r) => r.id);
        if (fbOtnRequestIds.length) await tx.fb_otn_subscribers.deleteMany({ where: { fb_otn_request_id: { in: fbOtnRequestIds } } });
        await tx.fb_otn_requests.deleteMany({ where: { fb_page_id: { in: fbPageIds } } });
        await tx.fb_chats.deleteMany({ where: { fb_page_id: { in: fbPageIds } } });
        await tx.fb_page_users.deleteMany({ where: { fb_page_id: { in: fbPageIds } } });
        await tx.fb_features.deleteMany({ where: { fb_page_id: { in: fbPageIds } } });
      }
      await tx.fb_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.fb_pages.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Telegram ─────────────────────────────────────────────────────
      const telegramBots = await tx.telegram_bots.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const telegramBotIds = telegramBots.map((b) => b.id);
      if (telegramBotIds.length) {
        const telegramChats = await tx.telegram_chats.findMany({ where: { telegram_bot_id: { in: telegramBotIds } }, select: { id: true } });
        const telegramChatIds = telegramChats.map((c) => c.id);
        if (telegramChatIds.length) {
          await tx.telegram_messages.deleteMany({ where: { telegram_chat_id: { in: telegramChatIds } } });
          await tx.telegram_contacts.deleteMany({ where: { telegram_chat_id: { in: telegramChatIds } } });
        }
        await tx.telegram_chats.deleteMany({ where: { telegram_bot_id: { in: telegramBotIds } } });
        await tx.telegram_bot_users.deleteMany({ where: { telegram_bot_id: { in: telegramBotIds } } });
      }
      await tx.telegram_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.telegram_bots.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Twilio (voice/SMS) ───────────────────────────────────────────
      const twilioAccounts = await tx.twilio_accounts.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const twilioAccountIds = twilioAccounts.map((a) => a.id);
      if (twilioAccountIds.length) {
        const twilioChats = await tx.twilio_chats.findMany({ where: { twilio_account_id: { in: twilioAccountIds } }, select: { id: true } });
        const twilioChatIds = twilioChats.map((c) => c.id);
        if (twilioChatIds.length) await tx.twilio_messages.deleteMany({ where: { twilio_chat_id: { in: twilioChatIds } } });
        await tx.twilio_chats.deleteMany({ where: { twilio_account_id: { in: twilioAccountIds } } });
        await tx.twilio_call_logs.deleteMany({ where: { twilio_account_id: { in: twilioAccountIds } } });
        await tx.twilio_account_users.deleteMany({ where: { twilio_account_id: { in: twilioAccountIds } } });
        await tx.twilio_numbers.deleteMany({ where: { twilio_account_id: { in: twilioAccountIds } } });
      }
      await tx.twilio_sip_credentials.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.twilio_sms_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.twilio_accounts.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Z-API ────────────────────────────────────────────────────────
      const zapiInstances = await tx.zapi_instances.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const zapiInstanceIds = zapiInstances.map((i) => i.id);
      if (zapiInstanceIds.length) {
        const zapiChats = await tx.zapi_chats.findMany({ where: { zapi_instance_id: { in: zapiInstanceIds } }, select: { id: true } });
        const zapiChatIds = zapiChats.map((c) => c.id);
        if (zapiChatIds.length) await tx.zapi_messages.deleteMany({ where: { zapi_chat_id: { in: zapiChatIds } } });
        await tx.zapi_chats.deleteMany({ where: { zapi_instance_id: { in: zapiInstanceIds } } });
      }
      await tx.zapi_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.zapi_instances.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Evolution API ────────────────────────────────────────────────
      const evolutionInstances = await tx.evolution_instances.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const evolutionInstanceIds = evolutionInstances.map((i) => i.id);
      if (evolutionInstanceIds.length) {
        const evolutionChats = await tx.evolution_chats.findMany({ where: { evolution_instance_id: { in: evolutionInstanceIds } }, select: { id: true } });
        const evolutionChatIds = evolutionChats.map((c) => c.id);
        if (evolutionChatIds.length) await tx.evolution_messages.deleteMany({ where: { evolution_chat_id: { in: evolutionChatIds } } });
        await tx.evolution_chats.deleteMany({ where: { evolution_instance_id: { in: evolutionInstanceIds } } });
      }
      await tx.evolution_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.evolution_instances.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Webchat (wc_*) ───────────────────────────────────────────────
      const wcInstances = await tx.wc_instances.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const wcInstanceIds = wcInstances.map((i) => i.id);
      if (wcInstanceIds.length) {
        const wcChats = await tx.wc_chats.findMany({ where: { wc_instance_id: { in: wcInstanceIds } }, select: { id: true } });
        const wcChatIds = wcChats.map((c) => c.id);
        if (wcChatIds.length) await tx.wc_messages.deleteMany({ where: { wc_chat_id: { in: wcChatIds } } });
        await tx.wc_chats.deleteMany({ where: { wc_instance_id: { in: wcInstanceIds } } });
      }
      await tx.wc_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.wc_instances.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Chatbots ─────────────────────────────────────────────────────
      const chatbots = await tx.chatbots.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const chatbotIds = chatbots.map((c) => c.id);
      if (chatbotIds.length) {
        const chatbotChats = await tx.chatbot_chats.findMany({ where: { chatbot_id: { in: chatbotIds } }, select: { id: true } });
        const chatbotChatIds = chatbotChats.map((c) => c.id);
        if (chatbotChatIds.length) await tx.chatbot_messages.deleteMany({ where: { chat_id: { in: chatbotChatIds } } });
        await tx.chatbot_chats.deleteMany({ where: { chatbot_id: { in: chatbotIds } } });
      }
      await tx.chatbot_statistics.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.chatbots.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Cross-channel inbox/misc ─────────────────────────────────────
      await tx.message_reactions.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.chat_inputs.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.inbox.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.inbox_folders.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.inbox_settings.deleteMany({ where: { workspace_id: workspaceId } });
      // inbox_system_fields.workspace_id is Int, not BigInt — cast.
      await tx.inbox_system_fields.deleteMany({ where: { workspace_id: Number(workspaceId) } });
      await tx.support_numbers.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Channels / integrations ──────────────────────────────────────
      const difyBots = await tx.dify_bots.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const difyBotIds = difyBots.map((b) => b.id);
      if (difyBotIds.length) await tx.dify_messages.deleteMany({ where: { dify_bot_id: { in: difyBotIds } } });
      await tx.dify_bots.deleteMany({ where: { workspace_id: workspaceId } });

      await tx.baserow_accounts.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.cal_accounts.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.integrations.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.make_webhooks.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.make_hooks.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.webhooks.deleteMany({ where: { workspace_id: workspaceId } });

      const apiTriggers = await tx.api_triggers.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const apiTriggerIds = apiTriggers.map((t) => t.id);
      if (apiTriggerIds.length) await tx.api_trigger_requests.deleteMany({ where: { api_trigger_id: { in: apiTriggerIds } } });
      await tx.api_triggers.deleteMany({ where: { workspace_id: workspaceId } });

      await tx.capi_logs.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.capi.deleteMany({ where: { workspace_id: workspaceId } });

      const widgets = await tx.widgets.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const widgetIds = widgets.map((w) => w.id);
      if (widgetIds.length) await tx.widget_actions.deleteMany({ where: { widget_id: { in: widgetIds } } });
      await tx.widgets.deleteMany({ where: { workspace_id: workspaceId } });

      const iframes = await tx.iframes.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const iframeIds = iframes.map((f) => f.id);
      if (iframeIds.length) await tx.iframe_permissions.deleteMany({ where: { iframe_id: { in: iframeIds } } });
      await tx.iframes.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.iframe_menus.deleteMany({ where: { workspace_id: workspaceId } });

      await tx.voice_wallet.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.swich_accounts.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.swich_transactions.deleteMany({ where: { workspace_id: workspaceId } });

      // ── AI ────────────────────────────────────────────────────────────
      const aiAgents = await tx.ai_agents.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const aiAgentIds = aiAgents.map((a) => a.id);
      if (aiAgentIds.length) {
        const aiThreads = await tx.ai_threads.findMany({ where: { agent_id: { in: aiAgentIds } }, select: { id: true } });
        const aiThreadIds = aiThreads.map((t) => t.id);
        if (aiThreadIds.length) await tx.ai_messages.deleteMany({ where: { thread_id: { in: aiThreadIds } } });
        await tx.ai_threads.deleteMany({ where: { agent_id: { in: aiAgentIds } } });
        await tx.ai_logs.deleteMany({ where: { agent_id: { in: aiAgentIds } } });
        await tx.ai_files.deleteMany({ where: { agent_id: { in: aiAgentIds } } });
        await tx.ai_functions.deleteMany({ where: { agent_id: { in: aiAgentIds } } });
      }
      await tx.ai_agents.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_accounts.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_feeders.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_knowledgebases.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_message_daily_stats.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_products.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_questions.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_themes.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_topics.deleteMany({ where: { workspace_id: workspaceId } });

      const aiVoiceAgents = await tx.ai_voice_agents.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const aiVoiceAgentIds = aiVoiceAgents.map((a) => a.id);
      if (aiVoiceAgentIds.length) {
        await tx.ai_voice_agent_file.deleteMany({ where: { ai_voice_agent_id: { in: aiVoiceAgentIds } } });
        await tx.ai_voice_agent_functions.deleteMany({ where: { ai_voice_agent_id: { in: aiVoiceAgentIds } } });
        await tx.ai_voice_agent_knowledgebase.deleteMany({ where: { ai_voice_agent_id: { in: aiVoiceAgentIds } } });
      }
      await tx.ai_voice_agents.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_voice_files.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.ai_voice_logs.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Automations ──────────────────────────────────────────────────
      const automations = await tx.automations.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const automationIds = automations.map((a) => a.id);
      if (automationIds.length) {
        const automationVersions = await tx.automation_versions.findMany({ where: { automation_id: { in: automationIds } }, select: { id: true } });
        const automationVersionIds = automationVersions.map((v) => v.id);
        if (automationVersionIds.length) {
          const automationSteps = await tx.automation_steps.findMany({ where: { automation_version_id: { in: automationVersionIds } }, select: { id: true } });
          const automationStepIds = automationSteps.map((s) => s.id);
          if (automationStepIds.length) {
            await tx.automation_quick_replies.deleteMany({ where: { automation_step_id: { in: automationStepIds } } });
            await tx.automation_quick_reply_followups.deleteMany({ where: { automation_step_id: { in: automationStepIds } } });
            await tx.automation_quick_reply_retries.deleteMany({ where: { automation_step_id: { in: automationStepIds } } });
            const stepActivities = await tx.automation_step_activities.findMany({ where: { step_id: { in: automationStepIds } }, select: { id: true } });
            const stepActivityIds = stepActivities.map((s) => s.id);
            if (stepActivityIds.length) await tx.automation_activity_iterations.deleteMany({ where: { activity_id: { in: stepActivityIds } } });
            await tx.automation_step_activities.deleteMany({ where: { step_id: { in: automationStepIds } } });
          }
          await tx.automation_flow.deleteMany({ where: { automation_version_id: { in: automationVersionIds } } });
          await tx.automation_steps.deleteMany({ where: { automation_version_id: { in: automationVersionIds } } });
        }
        await tx.automation_versions.deleteMany({ where: { automation_id: { in: automationIds } } });
        await tx.automation_objects.deleteMany({ where: { automation_id: { in: automationIds } } });
        await tx.automation_runs.deleteMany({ where: { automation_id: { in: automationIds } } });
        await tx.automation_activity_clicks.deleteMany({ where: { automation_id: { in: automationIds } } });
        await tx.automation_quick_reply_clicks.deleteMany({ where: { automation_id: { in: automationIds } } });
      }
      await tx.automations.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.automation_folders.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Bookings / pipeline / tasks / teams ──────────────────────────
      await tx.bookings.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.booking_logs.deleteMany({ where: { workspace_id: workspaceId } });

      const pipelines = await tx.pipelines.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const pipelineIds = pipelines.map((p) => p.id);
      const opportunities = await tx.pipeline_opportunities.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const opportunityIds = opportunities.map((o) => o.id);
      if (opportunityIds.length) {
        await tx.pipeline_opportunity_contacts.deleteMany({ where: { opportunity_id: { in: opportunityIds } } });
        await tx.pipeline_opportunity_notes.deleteMany({ where: { opportunity_id: { in: opportunityIds } } });
        await tx.pipeline_opportunity_step_logs.deleteMany({ where: { opportunity_id: { in: opportunityIds } } });
      }
      await tx.pipeline_opportunities.deleteMany({ where: { workspace_id: workspaceId } });
      if (pipelineIds.length) {
        await tx.pipeline_actions.deleteMany({ where: { pl_id: { in: pipelineIds } } });
        await tx.pipeline_lost_reasons.deleteMany({ where: { pl_id: { in: pipelineIds } } });
        await tx.pipeline_permissions.deleteMany({ where: { pl_id: { in: pipelineIds } } });
        await tx.pipeline_steps.deleteMany({ where: { pl_id: { in: pipelineIds } } });
      }
      await tx.pipelines.deleteMany({ where: { workspace_id: workspaceId } });

      await tx.tasks.deleteMany({ where: { workspace_id: workspaceId } });

      const teams = await tx.teams.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const teamIds = teams.map((t) => t.id);
      if (teamIds.length) await tx.team_members.deleteMany({ where: { team_id: { in: teamIds } } });
      await tx.teams.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Billing / usage ───────────────────────────────────────────────
      await tx.workspace_usage.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.mobile_app_tokens.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Custom fields / tags ─────────────────────────────────────────
      const customFields = await tx.custom_fields.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const customFieldIds = customFields.map((f) => f.id);
      if (customFieldIds.length) {
        const cfEntities = await tx.custom_field_entities.findMany({ where: { custom_field_id: { in: customFieldIds } }, select: { id: true } });
        const cfEntityIds = cfEntities.map((e) => e.id);
        if (cfEntityIds.length) await tx.custom_field_entity_values.deleteMany({ where: { cf_entity_id: { in: cfEntityIds } } });
        await tx.custom_field_entities.deleteMany({ where: { custom_field_id: { in: customFieldIds } } });
        await tx.custom_field_properties.deleteMany({ where: { custom_field_id: { in: customFieldIds } } });
      }
      await tx.custom_fields.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.custom_field_folders.deleteMany({ where: { workspace_id: workspaceId } });

      const tags = await tx.tags.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const tagIds = tags.map((t) => t.id);
      if (tagIds.length) await tx.tag_links.deleteMany({ where: { tag_id: { in: tagIds } } });
      await tx.tags.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.tag_folders.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Contacts & companies ─────────────────────────────────────────
      const contacts = await tx.contacts.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const contactIds = contacts.map((c) => c.id);
      if (contactIds.length) {
        await tx.automation_activity_iterations.deleteMany({ where: { contact_id: { in: contactIds } } });
        await tx.channel_opts.deleteMany({ where: { contact_id: { in: contactIds } } });
        await tx.contact_date_triggers.deleteMany({ where: { contact_id: { in: contactIds } } });
        await tx.contact_date_values.deleteMany({ where: { contact_id: { in: contactIds } } });
        await tx.contact_last_messages.deleteMany({ where: { contact_id: { in: contactIds } } });
        await tx.contact_opting.deleteMany({ where: { contact_id: { in: contactIds } } });
        await tx.notes.deleteMany({ where: { contact_id: { in: contactIds } } });
      }
      await tx.contact_export_requests.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.conversion_events.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.referrals.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.quick_filters.deleteMany({ where: { workspace_id: workspaceId } });

      const quickResponses = await tx.quick_responses.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const quickResponseIds = quickResponses.map((q) => q.id);
      if (quickResponseIds.length) await tx.quick_response_media.deleteMany({ where: { quick_response_id: { in: quickResponseIds } } });
      await tx.quick_responses.deleteMany({ where: { workspace_id: workspaceId } });

      // contact_mobiles / contact_emails are polymorphic on the OWNED entity
      // (modelable_type=Contact or User) but always carry ownership_type /
      // ownership_id pinned to the owning Workspace (see contacts.service.ts
      // findContactByEmail and workspaces.service.ts upsertWorkspaceUserMobile)
      // — a single filter on ownership_* catches both contact-owned and
      // workspace-user-owned rows for this workspace in one shot.
      await tx.contact_mobiles.deleteMany({ where: { ownership_type: 'App\\Models\\Workspace', ownership_id: workspaceId } });
      await tx.contact_emails.deleteMany({ where: { ownership_type: 'App\\Models\\Workspace', ownership_id: workspaceId } });

      const companies = await tx.companies.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
      const companyIds = companies.map((c) => c.id);
      if (companyIds.length) await tx.notes.deleteMany({ where: { company_id: { in: companyIds } } });
      await tx.companies.deleteMany({ where: { workspace_id: workspaceId } });

      await tx.contacts.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Workspace's own users + auxiliary tables ─────────────────────
      const users = await tx.users.findMany({
        where: { modelable_id: workspaceId, modelable_type: 'App\\Models\\Workspace' },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);
      if (userIds.length) {
        await tx.acl_roleables.deleteMany({ where: { roleable_type: 'App\\Models\\User', roleable_id: { in: userIds } } });
        await tx.user_accesses.deleteMany({ where: { user_id: { in: userIds } } });
        await tx.user_limits.deleteMany({ where: { user_id: { in: userIds } } });
        await tx.user_login_policies.deleteMany({ where: { user_id: { in: userIds } } });
        await tx.user_states.deleteMany({ where: { user_id: { in: userIds } } });
        await tx.user_call_counters.deleteMany({ where: { user_id: { in: userIds } } });
        await tx.user_accepted_terms.deleteMany({ where: { user_id: { in: userIds } } });
        // Legacy Laravel-Passport-style tables — unused by this Node app (no
        // references anywhere in src/), kept as a defensive cleanup in case
        // rows exist from the pre-rewrite system. user_id is a plain column
        // here, not polymorphic.
        await tx.oauth_access_tokens.deleteMany({ where: { user_id: { in: userIds } } });
        await tx.oauth_auth_codes.deleteMany({ where: { user_id: { in: userIds } } });
        // personal_access_tokens for individual users, IF the legacy PHP app's
        // Sanctum convention was ever used (defensive; unconfirmed in this repo).
        await tx.personal_access_tokens.deleteMany({ where: { tokenable_type: 'App\\Models\\User', tokenable_id: { in: userIds } } });
      }
      await tx.users.deleteMany({ where: { modelable_id: workspaceId, modelable_type: 'App\\Models\\Workspace' } });

      // Workspace-level API keys — confirmed real usage in
      // integrations.service.ts (getApiKeys/generateApiKey): tokenable_type
      // is the literal string 'Workspace' (not 'App\Models\Workspace'), and
      // tokenable_id is the workspace id directly, not a user id.
      await tx.personal_access_tokens.deleteMany({ where: { tokenable_type: 'Workspace', tokenable_id: workspaceId } });

      // ── ACL roles owned by this workspace ────────────────────────────
      const roles = await tx.acl_roles.findMany({
        where: { ownerable_id: workspaceId, ownerable_type: 'App\\Models\\Workspace' },
        select: { id: true },
      });
      // acl_role_permissions.role_id / acl_roleables.role_id are Int, not BigInt — cast.
      const roleIdsNum = roles.map((r) => Number(r.id));
      if (roleIdsNum.length) {
        await tx.acl_role_permissions.deleteMany({ where: { role_id: { in: roleIdsNum } } });
        await tx.acl_roleables.deleteMany({ where: { role_id: { in: roleIdsNum } } });
      }
      await tx.acl_roles.deleteMany({ where: { ownerable_id: workspaceId, ownerable_type: 'App\\Models\\Workspace' } });

      // ── White-label / domain / email ─────────────────────────────────
      await tx.brandings.deleteMany({ where: { brandable_id: workspaceId, brandable_type: 'App\\Models\\Workspace' } });
      await tx.domains.deleteMany({ where: { modelable_id: workspaceId, modelable_type: 'App\\Models\\Workspace' } });
      await tx.notification_emails.deleteMany({ where: { modelable_id: workspaceId, modelable_type: 'App\\Models\\Workspace' } });

      // ── Misc ──────────────────────────────────────────────────────────
      await tx.events_queue.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Bundles (cross-workspace-share safety check) ─────────────────
      // bundles.workspace_id is Int, not BigInt — cast.
      const ownBundles = await tx.bundles.findMany({ where: { workspace_id: Number(workspaceId) }, select: { id: true, name: true } });
      for (const bundle of ownBundles) {
        const [downloadedElsewhere, sharedElsewhere] = await Promise.all([
          tx.bundle_downloads.findFirst({ where: { bundle_id: bundle.id, workspace_id: { not: workspaceId } }, select: { id: true } }),
          tx.bundle_shares.findFirst({ where: { bundle_id: bundle.id, workspace_id: { not: workspaceId } }, select: { id: true } }),
        ]);
        if (downloadedElsewhere || sharedElsewhere) {
          skippedBundles.push({ id: bundle.id.toString(), name: bundle.name });
          continue;
        }
        await tx.bundle_instructions.deleteMany({ where: { bundle_id: bundle.id } });
        await tx.bundle_prompts.deleteMany({ where: { bundle_id: bundle.id } });
        await tx.bundle_resources.deleteMany({ where: { bundle_id: bundle.id } });
        await tx.bundle_downloads.deleteMany({ where: { bundle_id: bundle.id } });
        await tx.bundle_shares.deleteMany({ where: { bundle_id: bundle.id } });
        await tx.bundles.delete({ where: { id: bundle.id } });
      }
      // This workspace's own download/share history as the downloader/recipient
      // of OTHER workspaces' bundles — always safe, it's just this workspace's history.
      await tx.bundle_downloads.deleteMany({ where: { workspace_id: workspaceId } });
      await tx.bundle_shares.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Media gallery (capture for a future S3 cleanup job, then delete) ──
      const media = await tx.media_gallery.findMany({
        where: { workspace_id: workspaceId },
        select: { id: true, file_path: true, file_url: true },
      });
      for (const m of media) {
        mediaToCleanup.push({ id: m.id.toString(), file_path: m.file_path, file_url: m.file_url });
      }
      await tx.media_gallery.deleteMany({ where: { workspace_id: workspaceId } });

      // ── Finally, the workspace row itself ────────────────────────────
      await tx.workspaces.delete({ where: { id: workspaceId } });
    }, { timeout: 120000 });

    // Outside the transaction, and deliberately AFTER it commits — agency_logs
    // has no FK to workspaces, so this still works even though the workspace
    // row is gone by now. This is exactly why agency_logs (and audit_logs)
    // are excluded from the purge above.
    await this.logAgencyEvent(agencyId, 'workspace_deleted', actorId, 'App\\Models\\Workspace', workspaceId, {
      workspace_name: workspace.name,
    });

    return { success: true, skippedBundles, mediaToCleanup };
  }

  async getWorkspaceUsage(workspaceId: bigint, agencyId: bigint) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const [contactsUsed, agentsUsed, aiAssistantsUsed, whatsappUsed, instagramUsed, facebookUsed] =
      await Promise.all([
        this.prisma.contacts.count({ where: { workspace_id: workspaceId, deleted_at: null } }),
        this.prisma.users.count({
          where: { modelable_id: workspaceId, modelable_type: 'App\\Models\\Workspace' },
        }),
        this.prisma.ai_agents.count({ where: { workspace_id: workspaceId } }),
        this.prisma.wa_accounts.count({ where: { workspace_id: workspaceId, deleted_at: null } }),
        this.prisma.insta_pages.count({
          where: { workspace_id: workspaceId, deleted_at: null, platform: 'instagram' },
        }),
        this.prisma.insta_pages.count({
          where: { workspace_id: workspaceId, deleted_at: null, platform: 'facebook' },
        }),
      ]);

    return {
      success: true,
      usage: {
        contacts: {
          used: contactsUsed,
          limit: workspace.limited_contacts ? workspace.maximum_contacts : null,
        },
        agents: { used: agentsUsed, limit: workspace.agents_limit },
        ai_assistants: { used: aiAssistantsUsed, limit: workspace.chatgpt_assistant_limit },
        channels: {
          whatsapp: { used: whatsappUsed, limit: workspace.whatsapp_channels_limit },
          instagram: { used: instagramUsed, limit: workspace.instagram_channels_limit },
          facebook: { used: facebookUsed, limit: workspace.facebook_channels_limit },
        },
      },
    };
  }

  async getVoiceWallet(workspaceId: bigint, agencyId: bigint) {
    const workspace = await this.prisma.workspaces.findFirst({
      where: { id: workspaceId, agency_id: agencyId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const transactions = await this.prisma.voice_wallet.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    return {
      balance_seconds: Number(transactions[0]?.balance ?? 0),
      transactions: transactions.map((t) => ({
        id: t.id.toString(),
        type: t.transaction_type,
        description: t.description,
        seconds: Number(t.seconds),
        balance_after: Number(t.balance),
        created_at: t.created_at,
      })),
    };
  }

  // ─── Member Management ──────────────────────────────────────────────

  async members(agencyId: bigint) {
    const users = await this.prisma.users.findMany({
      where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      // Keep the agency owner pinned at the top, then newest users first so a
      // freshly added member appears right under the owner. Order by id (PK,
      // never null) rather than created_at which can be null on migrated rows.
      orderBy: [{ is_owner: 'desc' }, { id: 'desc' }],
    });

    // Batch-load every member's mobile/whatsapp in one query (avoids N+1) and
    // map their country_id → iso2 so the edit form can pre-fill the selectors.
    const userIds = users.map((u) => u.id);
    const mobiles = userIds.length
      ? await this.prisma.contact_mobiles.findMany({
          where: {
            modelable_type: 'App\\Models\\User',
            modelable_id: { in: userIds },
            slug: { in: ['mobile', 'whatsapp'] },
          },
        })
      : [];
    const countryIds = [...new Set(mobiles.map((m) => m.country_id))];
    const countries = countryIds.length
      ? await this.prisma.countries.findMany({ where: { id: { in: countryIds } }, select: { id: true, iso2: true } })
      : [];
    const iso = new Map(countries.map((c) => [String(c.id), c.iso2]));

    // Attach actual role name from acl_roleables → acl_roles
    const enriched = await Promise.all(users.map(async (u) => {
      const roleable = await this.prisma.acl_roleables.findFirst({
        where: { roleable_id: u.id, roleable_type: 'App\\Models\\User' },
      });
      let roleName = 'Agent';
      let roleSlug = '';
      let roleId: string | null = null;
      if (roleable) {
        const role = await this.prisma.acl_roles.findUnique({ where: { id: BigInt(roleable.role_id) } });
        if (role) { roleName = role.name; roleSlug = role.slug ?? ''; roleId = String(role.id); }
      }
      const mob = mobiles.find((m) => String(m.modelable_id) === String(u.id) && m.slug === 'mobile');
      const wa = mobiles.find((m) => String(m.modelable_id) === String(u.id) && m.slug === 'whatsapp');
      return {
        ...u,
        role: roleName,
        // Return the assigned role's slug + id so the edit form can pre-select the
        // dropdown directly — no fragile name→slug matching on the client.
        role_slug: roleSlug,
        role_id: roleId,
        phone: mob?.mobile_number ?? '',
        phone_country: mob ? (iso.get(String(mob.country_id)) ?? '') : '',
        whatsapp: wa?.mobile_number ?? '',
        whatsapp_country: wa ? (iso.get(String(wa.country_id)) ?? '') : '',
      };
    }));

    return { success: true, members: this.serialize(enriched) };
  }


  async getMember(agencyId: bigint, memberId: bigint) {
    const user = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    if (!user) throw new NotFoundException('Member not found');

    return { success: true, member: this.serialize(user) };
  }

  async updateMember(agencyId: bigint, memberId: bigint, data: any, actorId: bigint = 0n) {
    const user = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });
    if (!user) throw new NotFoundException('Member not found');

    // Only set columns that exist on the users table. phone/whatsapp are not
    // user columns, and the form's "language" maps to the `locale` column
    // (mirrors addMember). Skip undefined fields so partial updates are safe.
    const updateData: any = {
      first_name: data.first_name,
      last_name: data.last_name,
      updated_at: new Date(),
    };
    if (data.language) updateData.locale = data.language;
    if (data.status) updateData.status = data.status;
    if (typeof data.tfa_required !== 'undefined') updateData.tfa_required = !!data.tfa_required;
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    const updated = await this.prisma.users.update({
      where: { id: memberId },
      data: updateData,
    });

    // Re-sync the role assignment when a role slug is provided (Edit form has a
    // role dropdown). Upsert keeps the single roleable row per user in sync.
    if (data.role) {
      const role = await this.prisma.acl_roles.findFirst({
        where: {
          // Frontend dropdown sends the role's exact stored slug, so match it
          // verbatim (replyagent parity — slugs are unique machine keys).
          slug: data.role,
          ownerable_id: agencyId,
          ownerable_type: 'App\\Models\\Agency',
        },
      });
      if (role) {
        // acl_roleables has only an index (not a unique constraint) on
        // (roleable_type, roleable_id), so upsert-by-compound-key isn't valid.
        // Clear any existing role link for this user, then create the new one —
        // guarantees a single, clean role assignment.
        await this.prisma.acl_roleables.deleteMany({
          where: { roleable_id: memberId, roleable_type: 'App\\Models\\User' },
        });
        await this.prisma.acl_roleables.create({
          data: {
            role_id: Number(role.id),
            roleable_id: memberId,
            roleable_type: 'App\\Models\\User',
          },
        });
      }
    }

    // Persist phone / whatsapp changes into contact_mobiles (replyagent parity).
    try {
      await this.upsertUserMobile(memberId, agencyId, 'mobile', data.phone_country, data.phone);
      await this.upsertUserMobile(memberId, agencyId, 'whatsapp', data.whatsapp_country, data.whatsapp);
    } catch (err: any) {
      this.logger.warn(`Failed to update member contact numbers: ${err?.message ?? err}`);
    }

    await this.logAgencyEvent(agencyId, 'user_updated', actorId, 'App\\Models\\User', memberId, {
      name: `${data.first_name ?? user.first_name ?? ''} ${data.last_name ?? user.last_name ?? ''}`.trim() || user.email,
      email: user.email,
    });

    return { success: true, member: this.serialize(updated) };
  }

  async removeMember(agencyId: bigint, memberId: bigint, actorId: bigint = 0n) {
    // Capture identity before deletion so the log can show who was removed.
    const target = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      select: { first_name: true, last_name: true, email: true, is_owner: true },
    });

    // The agency owner can never be deleted (gateway parity).
    if (target?.is_owner) {
      throw new BadRequestException('The agency owner cannot be deleted');
    }

    // Clean up role assignments before hard-deleting (no FK cascade in Prisma schema).
    await this.prisma.acl_roleables.deleteMany({
      where: { roleable_id: memberId, roleable_type: 'App\\Models\\User' },
    });

    const deleted = await this.prisma.users.deleteMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
    });

    if (deleted.count > 0) {
      await this.logAgencyEvent(agencyId, 'user_deleted', actorId, 'App\\Models\\User', memberId, {
        name: `${target?.first_name ?? ''} ${target?.last_name ?? ''}`.trim() || target?.email,
        email: target?.email,
      });
    }

    return { success: deleted.count > 0 };
  }

  async suspendMember(agencyId: bigint, memberId: bigint, actorId: bigint = 0n) {
    const target = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      select: { first_name: true, last_name: true, email: true },
    });
    const updated = await this.prisma.users.updateMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      data: { status: 'SUSPENDED', updated_at: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Member not found in this agency');
    await this.logAgencyEvent(agencyId, 'user_suspended', actorId, 'App\\Models\\User', memberId, {
      name: `${target?.first_name ?? ''} ${target?.last_name ?? ''}`.trim() || target?.email,
      email: target?.email,
    });
    return { success: true };
  }

  async activateMember(agencyId: bigint, memberId: bigint, actorId: bigint = 0n) {
    const target = await this.prisma.users.findFirst({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      select: { first_name: true, last_name: true, email: true },
    });
    const updated = await this.prisma.users.updateMany({
      where: { id: memberId, modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      data: { status: 'ACTIVE', updated_at: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Member not found in this agency');
    await this.logAgencyEvent(agencyId, 'user_activated', actorId, 'App\\Models\\User', memberId, {
      name: `${target?.first_name ?? ''} ${target?.last_name ?? ''}`.trim() || target?.email,
      email: target?.email,
    });
    return { success: true };
  }

  /**
   * Dashboard stats — agency-wide totals (replyagent parity). An agent sees the
   * whole agency's counts; visibility is gated by module permissions, not by who
   * created each resource. The recent-activity feed shows the real actor name.
   */
  async getDashboardStats(agencyId: bigint, _user?: any) {
    // Window for "30 day" metrics — used by messages-sent, new-workspaces, response-time.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Workspace IDs for this agency drive every per-workspace metric below
    // (conversations, messages, workspace users). Single query, reused.
    const agencyWorkspaces = await this.prisma.workspaces.findMany({
      where: { agency_id: agencyId, deleted_at: null },
      select: { id: true },
    });
    const wsIds = agencyWorkspaces.map((w) => w.id);

    // Pre-fetch closed conversation samples for the response-time metric.
    // Done separately (not in Promise.all) so we can type the result without
    // colliding with the [] fallback branch on a never[] inference.
    const closedConversations: { created_at: Date | null; closed_at: Date | null }[] =
      wsIds.length
        ? await this.prisma.inbox.findMany({
            where: {
              workspace_id: { in: wsIds },
              status: 'COMPLETED',
              closed_at: { not: null, gte: thirtyDaysAgo },
              created_at: { not: null },
            },
            select: { created_at: true, closed_at: true },
            take: 500,
          })
        : [];

    const [
      totalWorkspaces,
      activeWorkspaces,
      newWorkspaces30d,
      totalAgents,
      workspaceUsersCount,
      totalConversations,
      openConversations,
      // "Messages Sent (30d)" proxied by count of inbox conversations whose
      // last_updated falls within the window — last_updated is bumped on every
      // incoming/outgoing message across all channels, so it's the cleanest
      // workspace-scoped activity metric without joining 4 channel-specific
      // message tables through 3-4 FK levels each.
      activeConversations30d,
      recentLogs,
    ] = await Promise.all([
      this.prisma.workspaces.count({
        where: { agency_id: agencyId, deleted_at: null },
      }),
      this.prisma.workspaces.count({
        where: { agency_id: agencyId, deleted_at: null, status: 'ACTIVE' },
      }),
      this.prisma.workspaces.count({
        where: { agency_id: agencyId, deleted_at: null, created_at: { gte: thirtyDaysAgo } },
      }),
      this.prisma.users.count({
        where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' },
      }),
      wsIds.length
        ? this.prisma.users.count({
            where: { modelable_id: { in: wsIds }, modelable_type: 'App\\Models\\Workspace' },
          })
        : 0,
      wsIds.length
        ? this.prisma.inbox.count({ where: { workspace_id: { in: wsIds } } })
        : 0,
      wsIds.length
        ? this.prisma.inbox.count({
            where: { workspace_id: { in: wsIds }, status: { in: ['ACTIVE', 'UNASSIGNED'] } },
          })
        : 0,
      wsIds.length
        ? this.prisma.inbox.count({
            where: { workspace_id: { in: wsIds }, last_updated: { gte: thirtyDaysAgo } },
          })
        : 0,
      this.prisma.agency_logs.findMany({
        where: { agency_id: agencyId },
        take: 5,
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const messagesSent30d = activeConversations30d;
    const totalUsers = totalAgents + workspaceUsersCount;

    // Average response time in minutes — avg(closed_at - created_at) across recently
    // resolved conversations. 0 when there's no sample (avoids NaN in UI).
    let avgResponseTimeMinutes = 0;
    if (closedConversations.length > 0) {
      const totalMs = closedConversations.reduce((sum: number, c) => {
        const start = c.created_at ? new Date(c.created_at).getTime() : 0;
        const end = c.closed_at ? new Date(c.closed_at).getTime() : 0;
        return sum + Math.max(0, end - start);
      }, 0);
      avgResponseTimeMinutes = Math.round(totalMs / closedConversations.length / 60000);
    }

    // agency_logs has no Prisma relation to users, so batch-fetch the actors to
    // show real names in the recent-activity feed instead of a generic "System".
    const logUserIds = Array.from(
      new Set((recentLogs as any[]).filter(l => l.user_id != null).map(l => l.user_id)),
    ) as bigint[];
    const logUsers = logUserIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: logUserIds } },
          select: { id: true, first_name: true, last_name: true, email: true },
        })
      : [];
    const logUserById = new Map(logUsers.map((u: any) => [u.id.toString(), u]));

    return {
      success: true,
      stats: {
        total_workspaces: totalWorkspaces,
        active_workspaces: activeWorkspaces,
        new_workspaces_30d: newWorkspaces30d,
        total_agents: totalAgents,
        total_users: totalUsers,
        total_conversations: totalConversations,
        open_conversations: openConversations,
        messages_sent_30d: messagesSent30d,
        avg_response_time_minutes: avgResponseTimeMinutes,
        premium_support_seats: "0 of 5", // Still hardcoded as per business logic usually
      },
      recent_activity: (recentLogs as any[]).map(log => {
        const u = log.user_id ? logUserById.get(log.user_id.toString()) : null;
        const name = u
          ? (`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email)
          : 'System';
        const initials = u
          ? (`${u.first_name?.[0] ?? ''}${u.last_name?.[0] ?? ''}`.toUpperCase()
              || (u.email?.[0]?.toUpperCase() ?? 'S'))
          : 'S';
        return {
          name,
          action: log.event.replace(/_/g, ' '),
          target: log.modelable_type?.split('\\').pop() || 'System',
          time: log.created_at,
          initials,
        };
      }),
    };
  }

  /**
   * Workspace-level audit logs (audit_logs table) with user hydration and
   * pagination. Optional filters: workspace_id (specific WS), event (slug),
   * date range, user_id, page/per_page.
   */
  async getAuditLogs(agencyId: bigint, q: any = {}) {
    const where: any = {};
    // Restrict to workspaces of this agency
    const wsIds = (
      await this.prisma.workspaces.findMany({
        where: { agency_id: agencyId, deleted_at: null },
        select: { id: true },
      })
    ).map((w) => w.id);

    if (wsIds.length === 0) {
      return { success: true, logs: [], total: 0, page: 1, per_page: 20 };
    }

    where.workspace_id = q.workspace_id ? BigInt(q.workspace_id) : { in: wsIds };
    if (q.event) where.event = q.event;
    if (q.user_id) where.user_id = BigInt(q.user_id);
    if (q.from || q.to) {
      where.created_at = {} as any;
      if (q.from) (where.created_at as any).gte = parseRangeStart(q.from);
      if (q.to) (where.created_at as any).lte = parseRangeEnd(q.to);
    }

    const perPage = Math.min(parseInt(q.per_page ?? '20', 10), 200);
    const page = Math.max(parseInt(q.page ?? '1', 10), 1);

    const [rows, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: perPage,
        skip: (page - 1) * perPage,
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    return { success: true, logs: await this.hydrateLogs(rows), total, page, per_page: perPage };
  }

  /**
   * Agency-level activity (agency_logs). Same shape as getAuditLogs but
   * scoped to this agency only.
   */
  async getAgencyLogs(agencyId: bigint, q: any = {}) {
    const where: any = { agency_id: agencyId };
    if (q.event) where.event = q.event;
    if (q.user_id) where.user_id = BigInt(q.user_id);
    if (q.from || q.to) {
      where.created_at = {} as any;
      if (q.from) (where.created_at as any).gte = parseRangeStart(q.from);
      if (q.to) (where.created_at as any).lte = parseRangeEnd(q.to);
    }

    const perPage = Math.min(parseInt(q.per_page ?? '20', 10), 200);
    const page = Math.max(parseInt(q.page ?? '1', 10), 1);

    const [rows, total] = await Promise.all([
      this.prisma.agency_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: perPage,
        skip: (page - 1) * perPage,
      }),
      this.prisma.agency_logs.count({ where }),
    ]);

    return { success: true, logs: await this.hydrateLogs(rows), total, page, per_page: perPage };
  }

  /**
   * Joins user details onto raw log rows (Prisma relations aren't defined for
   * audit_logs/agency_logs in this schema, so we batch-fetch users by id).
   * Returns serialized logs with `user`, `action`, `target` derived for UI.
   */
  private async hydrateLogs(rows: any[]) {
    // Batch-fetch users + workspaces because the underlying tables don't have
    // Prisma relations declared. One round-trip per entity type, then map back.
    const userIds = Array.from(
      new Set(rows.filter((r) => r.user_id != null).map((r) => r.user_id)),
    ) as bigint[];
    const wsIds = Array.from(
      new Set(rows.filter((r) => r.workspace_id != null && r.workspace_id !== 0n).map((r) => r.workspace_id)),
    ) as bigint[];

    const [users, workspaces] = await Promise.all([
      userIds.length
        ? this.prisma.users.findMany({
            where: { id: { in: userIds } },
            select: { id: true, first_name: true, last_name: true, email: true },
          })
        : Promise.resolve([] as any[]),
      wsIds.length
        ? this.prisma.workspaces.findMany({
            where: { id: { in: wsIds } },
            select: { id: true, name: true, slug: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const userById = new Map(users.map((u: any) => [u.id.toString(), u]));
    const wsById = new Map(workspaces.map((w: any) => [w.id.toString(), w]));

    return rows.map((r) => {
      const u = r.user_id ? userById.get(r.user_id.toString()) : null;
      const w = r.workspace_id ? wsById.get(r.workspace_id.toString()) : null;
      return {
        id: r.id?.toString(),
        agency_id: r.agency_id?.toString(),
        workspace_id: r.workspace_id?.toString(),
        workspace: w
          ? { id: w.id.toString(), name: w.name, slug: w.slug }
          : null,
        event: r.event,
        action: (r.event ?? '').replace(/_/g, ' '),
        target: r.modelable_type?.split('\\').pop() ?? null,
        modelable_id: r.modelable_id?.toString(),
        data: r.data,
        created_at: r.created_at,
        user: u
          ? {
              id: u.id.toString(),
              name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email,
              email: u.email,
            }
          : null,
      };
    });
  }

  async addMember(agencyId: bigint, data: any, actorId: bigint = 0n) {
    // Reject duplicate emails within this agency (gateway parity: agency->isMember).
    const existing = await this.prisma.users.findFirst({
      where: {
        email: data.email,
        modelable_id: agencyId,
        modelable_type: 'App\\Models\\Agency',
      },
    });
    if (existing) {
      throw new BadRequestException('A member with this email already exists in the agency');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await this.prisma.users.create({
      data: {
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        password: hashedPassword,
        locale: data.language || 'en',
        modelable_id: agencyId,
        modelable_type: 'App\\Models\\Agency',
        status: 'ACTIVE',
        creator_id: actorId,
        tfa_required: !!data.tfa_required,
      },
    });

    await this.logAgencyEvent(agencyId, 'user_created', actorId, 'App\\Models\\User', user.id, {
      name: `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim() || data.email,
      email: data.email,
    });

    // Handle Role Assignment
    if (data.role) {
      const role = await this.prisma.acl_roles.findFirst({
        where: {
          // Frontend dropdown sends the role's exact stored slug, so match it
          // verbatim (replyagent parity — slugs are unique machine keys).
          slug: data.role,
          ownerable_id: agencyId,
          ownerable_type: 'App\\Models\\Agency'
        }
      });

      if (role) {
        await this.prisma.acl_roleables.create({
          data: {
            role_id: Number(role.id),
            roleable_id: user.id,
            roleable_type: 'App\\Models\\User'
          }
        });
      }
    }

    // Persist the agent's phone / whatsapp into contact_mobiles (replyagent parity).
    // Wrapped so a contact-write hiccup never blocks user creation.
    try {
      await this.upsertUserMobile(user.id, agencyId, 'mobile', data.phone_country, data.phone);
      await this.upsertUserMobile(user.id, agencyId, 'whatsapp', data.whatsapp_country, data.whatsapp);
    } catch (err: any) {
      this.logger.warn(`Failed to save member contact numbers: ${err?.message ?? err}`);
    }

    return { success: true, user: this.serialize(user) };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  // Strip a phone number down to digits, dropping a leading 0 or + first
  // (mirrors replyagent's ContactHelper::removeNumberFormating).
  private cleanNumber(n: string): string {
    return String(n ?? '')
      .trim()
      .replace(/^[0+]+/, '')
      .replace(/[^0-9]/g, '');
  }

  /**
   * Persist an agent's mobile / whatsapp number into contact_mobiles, polymorphic
   * on the User — mirrors replyagent's ContactHelper::updateContactFields.
   *   slug : 'mobile' | 'whatsapp'   iso2 : 2-letter country code the form sends
   * No value → nothing written (replyagent parity: numbers aren't cleared here).
   * One row per (user, slug): existing row is updated, otherwise created.
   */
  private async upsertUserMobile(
    userId: bigint,
    agencyId: bigint,
    slug: 'mobile' | 'whatsapp',
    iso2: string | undefined,
    rawValue: string | undefined,
  ) {
    const digits = this.cleanNumber(rawValue ?? '');
    if (!digits) return; // nothing to store

    // country_id is required on contact_mobiles, so a valid country is mandatory.
    const country = iso2
      ? await this.prisma.countries.findFirst({ where: { iso2: iso2.toUpperCase() } })
      : null;
    if (!country) return;

    const phoneCode = String(country.phone_code ?? '').replace(/[^0-9]/g, ''); // e.g. "92"
    const national = `${phoneCode}${digits}`;        // 923123456789
    const full = `+${national}`;                     // +923123456789

    const fields = {
      country_id: country.id,
      country_code: country.phone_code ?? null,
      mobile_number: digits,
      national_mobile_number: national,
      full_mobile_number: full,
      type: slug,
      is_primary: 1,
      updated_at: new Date(),
    };

    const existing = await this.prisma.contact_mobiles.findFirst({
      where: { modelable_type: 'App\\Models\\User', modelable_id: userId, slug },
    });

    if (existing) {
      await this.prisma.contact_mobiles.update({ where: { id: existing.id }, data: fields });
    } else {
      await this.prisma.contact_mobiles.create({
        data: {
          ...fields,
          slug,
          modelable_type: 'App\\Models\\User',
          modelable_id: userId,
          ownership_type: 'App\\Models\\Agency',
          ownership_id: agencyId,
          created_at: new Date(),
        },
      });
    }
  }

  // Public so controllers can log events for actions handled by other services
  // (e.g. role create/update/delete go through RolesService).
  //
  // Logging must NEVER break the actual operation — it's a side-effect, always
  // the last step. So a failed log-write is caught and warned, not thrown.
  async logAgencyEvent(
    agencyId: bigint,
    event: string,
    userId: bigint,
    modelableType?: string,
    modelableId?: bigint,
    data?: any,
  ) {
    try {
      await this.prisma.agency_logs.create({
        data: {
          agency_id: agencyId,
          event: event,
          user_id: userId,
          modelable_type: modelableType,
          modelable_id: modelableId,
          data: data ? JSON.stringify(data) : null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to write agency_log "${event}" for agency ${agencyId}: ${err?.message}`,
      );
    }
  }

  private serialize(obj: any) {
    return JSON.parse(
      JSON.stringify(obj, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
