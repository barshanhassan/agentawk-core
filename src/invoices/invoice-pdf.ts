import PDFDocument from 'pdfkit';

export interface InvoicePdfData {
  invoice_number: string;
  issued_at: Date;
  period_end: Date;
  plan_name: string;
  amount: number;
  /** Pre-discount plan price. Falls back to `amount` when omitted (no coupons applied). */
  subtotal?: number;
  coupons?: Array<{ code: string; name: string; discount_amount: number }>;
  currency: string;
  billing_company: string | null;
  billing_person: string | null;
  tax_id: string | null;
  vat: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  address_country: string | null;
}

const BRAND_GREEN = '#25d366';
const INK = '#0B1020';
const MUTED = '#667085';
const BORDER = '#E5E7EB';

/** Renders a single-page A4 invoice PDF into a Buffer. No external service — self-contained, synchronous layout. */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header ──
    // Bot mark icon, redrawn with pdfkit's vector primitives (pdfkit can't
    // embed the SVG used elsewhere) — same proportions as the app's BotMark:
    // a rounded head with two cut-out "eyes", plus a separate body/legs rect.
    const iconX = 50;
    const iconY = 48;
    const s = 0.46;
    doc.fillColor(BRAND_GREEN);
    doc.roundedRect(iconX + 6 * s, iconY + 3 * s, 28 * s, 18 * s, 4 * s).fill();
    doc.fillColor('#FFFFFF');
    doc.circle(iconX + 14.2 * s, iconY + 12 * s, 3.2 * s).fill();
    doc.circle(iconX + 25.8 * s, iconY + 12 * s, 3.2 * s).fill();
    doc.fillColor(BRAND_GREEN);
    doc.roundedRect(iconX + 4 * s, iconY + 25 * s, 32 * s, 5.5 * s, 2 * s).fill();
    doc.roundedRect(iconX + 16.5 * s, iconY + 30 * s, 7 * s, 20 * s, 2 * s).fill();

    doc.fillColor(INK).fontSize(20).font('Helvetica-Bold').text('agen', 72, 50, { continued: true });
    doc.fillColor(BRAND_GREEN).text('tawk', { continued: false });
    doc.fillColor(MUTED).fontSize(9).font('Helvetica').text('WhatsApp, Messenger & Instagram, answered by AI.', 72, 74);

    doc.fillColor(INK).fontSize(16).font('Helvetica-Bold').text('INVOICE', 350, 50, { width: 195, align: 'right' });
    doc.fillColor(MUTED).fontSize(9).font('Helvetica');
    doc.text(`Invoice #: ${data.invoice_number}`, 350, 74, { width: 195, align: 'right' });
    doc.text(`Date: ${data.issued_at.toISOString().slice(0, 10)}`, 350, 88, { width: 195, align: 'right' });

    doc.moveTo(50, 115).lineTo(545, 115).strokeColor(BORDER).lineWidth(1).stroke();

    // ── Prominent "paid" statement ──
    let y = 135;
    doc.fillColor(INK).fontSize(18).font('Helvetica-Bold').text(
      `${data.currency} ${data.amount.toFixed(2)} paid on ${data.issued_at.toISOString().slice(0, 10)}`,
      50,
      y,
    );
    y += 34;

    // ── Bill To (company as the title, contact person explicitly labelled
    // "Attn:" so the two names can't be mistaken for each other) ──
    doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold').text('BILL TO', 50, y);
    y += 16;
    doc.fillColor(INK).fontSize(11).font('Helvetica-Bold');
    if (data.billing_company) {
      doc.text(data.billing_company, 50, y);
      y += 15;
    }
    doc.font('Helvetica').fontSize(10).fillColor('#333333');
    if (data.billing_person) {
      doc.text(`Attn: ${data.billing_person}`, 50, y);
      y += 14;
    }
    if (data.address_street) {
      doc.text(data.address_street, 50, y);
      y += 14;
    }
    const cityLine = [data.address_city, data.address_state, data.address_zip].filter(Boolean).join(', ');
    if (cityLine) {
      doc.text(cityLine, 50, y);
      y += 14;
    }
    if (data.address_country) {
      doc.text(data.address_country, 50, y);
      y += 14;
    }
    if (data.tax_id) {
      doc.text(`Tax ID: ${data.tax_id}`, 50, y);
      y += 14;
    }
    if (data.vat) {
      doc.text(`VAT: ${data.vat}`, 50, y);
      y += 14;
    }

    // ── Line item table ──
    y = Math.max(y + 25, 290);
    doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold');
    doc.text('DESCRIPTION', 50, y);
    doc.text('QTY', 380, y, { width: 40, align: 'right' });
    doc.text('AMOUNT', 450, y, { width: 95, align: 'right' });
    y += 16;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(BORDER).stroke();
    y += 12;

    const subtotal = data.subtotal ?? data.amount;
    const coupons = data.coupons ?? [];

    doc.fillColor(INK).fontSize(10).font('Helvetica');
    doc.text(data.plan_name, 50, y, { width: 320 });
    doc.text('1', 380, y, { width: 40, align: 'right' });
    doc.text(`${data.currency} ${subtotal.toFixed(2)}`, 450, y, { width: 95, align: 'right' });
    y += 14;
    doc.fillColor(MUTED).fontSize(8).text(
      `${data.issued_at.toISOString().slice(0, 10)} – ${data.period_end.toISOString().slice(0, 10)}`,
      50,
      y,
      { width: 320 },
    );
    y += 22;

    // One row per applied coupon — each already knocks its own % off the
    // subtotal independently (matches Billing → Manage's "Current Usage").
    for (const c of coupons) {
      doc.fillColor(INK).fontSize(9).font('Helvetica').text(`Coupon: ${c.name}`, 50, y, { width: 320 });
      doc.fillColor(BRAND_GREEN).text(`-${data.currency} ${c.discount_amount.toFixed(2)}`, 450, y, { width: 95, align: 'right' });
      y += 16;
    }

    y += 6;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(BORDER).stroke();
    y += 16;

    doc.fillColor(MUTED).fontSize(10).font('Helvetica').text('Subtotal', 350, y, { width: 95 });
    doc.fillColor(INK).text(`${data.currency} ${subtotal.toFixed(2)}`, 450, y, { width: 95, align: 'right' });
    y += 18;

    if (coupons.length) {
      const totalDiscount = coupons.reduce((sum, c) => sum + c.discount_amount, 0);
      doc.fillColor(MUTED).fontSize(10).font('Helvetica').text('Discount', 350, y, { width: 95 });
      doc.fillColor(BRAND_GREEN).text(`-${data.currency} ${totalDiscount.toFixed(2)}`, 450, y, { width: 95, align: 'right' });
      y += 18;
    }

    doc.fillColor(INK).fontSize(12).font('Helvetica-Bold');
    doc.text('Total', 350, y, { width: 95 });
    doc.text(`${data.currency} ${data.amount.toFixed(2)}`, 450, y, { width: 95, align: 'right' });

    // ── Footer ──
    doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(
      'This invoice was generated automatically upon payment. For questions, contact your account owner.',
      50,
      760,
      { width: 495, align: 'center' },
    );

    doc.end();
  });
}
