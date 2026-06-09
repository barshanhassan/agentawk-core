import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Provider-agnostic SMTP mailer. Everything is driven by env vars, so the same
 * code works with ANY SMTP provider — only the credentials change:
 *
 *   Gmail (testing):   SMTP_HOST=smtp.gmail.com  SMTP_PORT=587
 *                      SMTP_USER=you@gmail.com   SMTP_PASS=<16-char App Password>
 *                      SMTP_FROM=you@gmail.com
 *   SMTP2GO (prod):    SMTP_HOST=mail.smtp2go.com SMTP_PORT=587
 *                      SMTP_USER=<smtp2go user>  SMTP_PASS=<smtp2go password>
 *                      SMTP_FROM=noreply@yourdomain.com
 *
 * When SMTP_* is not set the mailer no-ops (logs a warning) instead of crashing,
 * so the app runs fine before any keys are dropped in.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: nodemailer.Transporter | null = null;
  private signature = ''; // env fingerprint so a later env change rebuilds the transport

  isConfigured(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  private getTransporter(): nodemailer.Transporter | null {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return null;

    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const sig = `${host}|${port}|${secure}|${user}`;
    if (this.transporter && this.signature === sig) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure, // true for 465, false for 587 (STARTTLS)
      auth: { user, pass },
    });
    this.signature = sig;
    return this.transporter;
  }

  private fromHeader(override?: string): string {
    const name = process.env.SMTP_FROM_NAME || 'EZCONN';
    const addr = override || process.env.SMTP_FROM || process.env.SMTP_USER || '';
    return `"${name}" <${addr}>`;
  }

  /** Verify the SMTP connection/credentials without sending anything. */
  async verifyConnection(): Promise<{ ok: boolean; configured: boolean; error?: string }> {
    const t = this.getTransporter();
    if (!t) return { ok: false, configured: false };
    try {
      await t.verify();
      return { ok: true, configured: true };
    } catch (e: any) {
      return { ok: false, configured: true, error: e?.message ?? String(e) };
    }
  }

  async sendMail(opts: {
    to: string;
    subject: string;
    html?: string;
    text?: string;
    from?: string;
  }): Promise<{ sent: boolean; skipped?: boolean; messageId?: string; error?: string }> {
    const t = this.getTransporter();
    if (!t) {
      this.logger.warn(
        `SMTP not configured (SMTP_HOST/USER/PASS missing) — skipped email to ${opts.to} ("${opts.subject}")`,
      );
      return { sent: false, skipped: true };
    }
    try {
      const info = await t.sendMail({
        from: this.fromHeader(opts.from),
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html ?? opts.text,
      });
      this.logger.log(`Email sent to ${opts.to} ("${opts.subject}") id=${info.messageId}`);
      return { sent: true, messageId: info.messageId };
    } catch (e: any) {
      this.logger.error(`Email send failed to ${opts.to}: ${e?.message ?? e}`);
      return { sent: false, error: e?.message ?? String(e) };
    }
  }
}
