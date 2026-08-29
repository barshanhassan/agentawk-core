import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { MailerService } from '../mail/mailer.service';
import { buildEmailHtml } from '../mail/email-template';
import { renderInvoicePdf } from './invoice-pdf';

function addPeriod(start: Date, amount: number, unit: string | null | undefined): Date {
  const d = new Date(start);
  switch (unit) {
    case 'year':
      d.setFullYear(d.getFullYear() + amount);
      break;
    case 'week':
      d.setDate(d.getDate() + amount * 7);
      break;
    case 'day':
      d.setDate(d.getDate() + amount);
      break;
    case 'month':
    default:
      d.setMonth(d.getMonth() + amount);
      break;
  }
  return d;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Called right after a Swich payment activates a plan (see
   * SwichService.activatePlanFromTransaction). Snapshots the agency's current
   * billing details, renders a PDF, stores it in S3, and emails it — this is
   * the from-scratch replacement for what Chargebee used to do automatically,
   * since Chargebee is never actually connected in this app.
   */
  async generateInvoice(params: {
    agencyId: bigint;
    billingSubscriptionId: bigint;
    planId: bigint;
    planName: string;
    customerTransactionId: string;
  }) {
    try {
      const [agency, price, address] = await Promise.all([
        this.prisma.agencies.findUnique({ where: { id: params.agencyId } }),
        this.prisma.billing_item_prices.findFirst({
          where: { itemable_id: params.planId, status: 'active' },
        }),
        this.prisma.addresses.findFirst({
          where: { addressable_id: params.agencyId, addressable_type: 'App\\Models\\Agency' },
        }),
      ]);
      if (!agency) {
        this.logger.warn(`generateInvoice: agency ${params.agencyId} not found — skipping`);
        return null;
      }

      const subtotal = price?.price != null ? price.price / 100 : 0;
      const currency = price?.currency_code || 'USD';
      const issuedAt = new Date();
      const periodEnd = addPeriod(issuedAt, price?.period || 1, price?.period_unit);

      // Coupons applied to this exact subscription, same "each knocks a %
      // off the subtotal independently" rule as AgencyService's Current
      // Usage calc (agency.service.ts) — kept in sync with that, not
      // imported from it, to avoid a circular AgencyModule<->InvoicesModule
      // dependency for what's a ~10-line lookup.
      const subscription = params.billingSubscriptionId
        ? await this.prisma.billing_subscriptions.findUnique({
            where: { id: params.billingSubscriptionId },
            select: { coupons: true },
          })
        : null;
      const couponCodes = (subscription?.coupons || '').split(',').map((c) => c.trim()).filter(Boolean);
      const appliedCoupons = couponCodes.length
        ? await this.prisma.billing_coupons.findMany({ where: { coupon_id: { in: couponCodes }, status: 'active' } })
        : [];
      const coupons = appliedCoupons.map((c) => ({
        code: c.coupon_id,
        name: c.invoice_name || c.coupon_id,
        discount_amount: c.discount_percentage
          ? Math.round(subtotal * (Number(c.discount_percentage) / 100) * 100) / 100
          : Number(c.discount_amount ?? 0),
      }));
      const discount = coupons.reduce((sum, c) => sum + c.discount_amount, 0);
      const amount = Math.max(0, subtotal - discount);

      // Placeholder invoice_number that's already guaranteed unique (the Swich
      // transaction id), so the unique constraint can't collide before we
      // know this row's real auto-increment id below.
      const created = await this.prisma.invoices.create({
        data: {
          agency_id: params.agencyId,
          billing_subscription_id: params.billingSubscriptionId,
          invoice_number: `pending-${params.customerTransactionId}`,
          plan_name: params.planName,
          amount,
          subtotal,
          discount,
          coupon_codes: coupons.length ? coupons.map((c) => c.code).join(',') : null,
          currency,
          status: 'paid',
          billing_company: agency.billing_company,
          billing_person: agency.billing_person,
          tax_id: agency.tax_id,
          vat: agency.vat,
          address_street: address?.street ?? null,
          address_city: address?.city ?? null,
          address_state: address?.state ?? null,
          address_zip: address?.zip ?? null,
          address_country: address?.country_iso2 ?? null,
          issued_at: issuedAt,
          created_at: issuedAt,
          updated_at: issuedAt,
        },
      });

      const invoiceNumber = `INV-${issuedAt.getFullYear()}-${String(created.id).padStart(6, '0')}`;

      const pdfBuffer = await renderInvoicePdf({
        invoice_number: invoiceNumber,
        issued_at: issuedAt,
        period_end: periodEnd,
        plan_name: params.planName,
        amount,
        subtotal,
        coupons,
        currency,
        billing_company: agency.billing_company,
        billing_person: agency.billing_person,
        tax_id: agency.tax_id,
        vat: agency.vat,
        address_street: address?.street ?? null,
        address_city: address?.city ?? null,
        address_state: address?.state ?? null,
        address_zip: address?.zip ?? null,
        address_country: address?.country_iso2 ?? null,
      });

      const s3Key = `invoices/a${params.agencyId}/${invoiceNumber}.pdf`;
      const uploaded = await this.s3.upload(pdfBuffer, s3Key, 'application/pdf');

      await this.prisma.invoices.update({
        where: { id: created.id },
        data: { invoice_number: invoiceNumber, pdf_s3_key: uploaded ? s3Key : null },
      });

      if (!uploaded) {
        this.logger.error(`Invoice ${invoiceNumber} PDF failed to upload to S3: ${this.s3.lastError}`);
      }

      await this.sendInvoiceEmail(params.agencyId, agency.email, invoiceNumber, uploaded ? s3Key : null);

      this.logger.log(`Generated invoice ${invoiceNumber} for agency ${params.agencyId}`);
      return { invoiceNumber, id: created.id };
    } catch (err: any) {
      // Invoicing must never block plan activation — log and move on.
      this.logger.error(`generateInvoice failed for agency ${params.agencyId}: ${err?.message ?? err}`);
      return null;
    }
  }

  private async sendInvoiceEmail(agencyId: bigint, agencyEmail: string | null, invoiceNumber: string, s3Key: string | null) {
    const recipients = new Set<string>();
    if (agencyEmail) recipients.add(agencyEmail);

    const agency = await this.prisma.agencies.findUnique({ where: { id: agencyId }, select: { notification_email: true } });
    (agency?.notification_email || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .forEach((e) => recipients.add(e));

    if (!recipients.size) return;

    const downloadUrl = s3Key ? await this.s3.getSignedUrl(s3Key, 60 * 60 * 24 * 7) : null;

    for (const to of recipients) {
      await this.mailer
        .sendMail({
          to,
          subject: `Invoice ${invoiceNumber}`,
          html: buildEmailHtml({
            heading: 'Your invoice is ready',
            bodyHtml: `<p style="margin:0">Invoice <b>${invoiceNumber}</b> for your recent plan payment is attached below.</p>`,
            ctaText: downloadUrl ? 'Download invoice' : undefined,
            ctaUrl: downloadUrl ?? undefined,
          }),
          text: `Invoice ${invoiceNumber} is ready.${downloadUrl ? ` Download: ${downloadUrl}` : ''}`,
        })
        .catch((err) => this.logger.warn(`Failed to email invoice ${invoiceNumber} to ${to}: ${err?.message ?? err}`));
    }
  }

  async list(agencyId: bigint) {
    const rows = await this.prisma.invoices.findMany({
      where: { agency_id: agencyId },
      orderBy: { issued_at: 'desc' },
      select: {
        id: true,
        invoice_number: true,
        plan_name: true,
        amount: true,
        currency: true,
        status: true,
        issued_at: true,
      },
    });
    return {
      invoices: rows.map((r) => ({
        id: r.id.toString(),
        invoice_number: r.invoice_number,
        plan_name: r.plan_name,
        amount: r.amount.toString(),
        currency: r.currency,
        status: r.status,
        issued_at: r.issued_at,
      })),
    };
  }

  async getDownloadUrl(agencyId: bigint, invoiceId: bigint) {
    const invoice = await this.prisma.invoices.findFirst({
      where: { id: invoiceId, agency_id: agencyId },
      select: { pdf_s3_key: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!invoice.pdf_s3_key) throw new NotFoundException('Invoice PDF is not available');
    const url = await this.s3.getSignedUrl(invoice.pdf_s3_key, 3600);
    return { url };
  }
}
