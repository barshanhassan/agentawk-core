import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Verifies inbound webhook signatures from supported providers. Mirrors the gateway
 * pattern (each provider signs requests with a shared secret; we recompute and
 * compare). When a provider's secret env var is unset we fail-OPEN with a logged
 * warning so dev (where webhooks are tunneled in without secrets) still works;
 * production deployments MUST set the env vars.
 */
@Injectable()
export class WebhookSignatureService {
  private readonly logger = new Logger(WebhookSignatureService.name);

  /**
   * Route signature verification to the provider-specific check. Returns true if
   * the signature is valid or skipped (no secret configured / unknown provider).
   * Throws nothing — controller decides what to do with `false`.
   */
  verify(provider: string, headers: Record<string, any>, rawBody: string | Buffer): boolean {
    switch (provider.toLowerCase()) {
      case 'whatsapp':
      case 'waba':
      case 'instagram':
      case 'messenger':
      case 'facebook':
        return this.verifyMeta(headers, rawBody);
      case 'twilio':
        // Twilio's signature uses full URL + form params, not just the body.
        // Controller must call verifyTwilio() directly with those — return false
        // here so a misrouted Twilio call through verify() fails closed.
        this.logger.warn('Twilio webhook routed through verify() — use verifyTwilio() directly');
        return false;
      case 'zapi':
        return this.verifyZapi(headers, rawBody);
      case 'evolution':
        return this.verifyEvolution(headers, rawBody);
      case 'telegram':
        // Telegram doesn't sign payloads — uses a secret URL path token instead,
        // checked separately in the controller via X-Telegram-Bot-Api-Secret-Token.
        return this.verifyTelegram(headers);
      default:
        this.logger.warn(`No signature scheme registered for provider="${provider}" — allowing`);
        return true;
    }
  }

  /**
   * Meta (WhatsApp Cloud / Instagram / Messenger) signs with HMAC-SHA256 of the
   * raw request body using META_APP_SECRET, sent as `X-Hub-Signature-256: sha256=<hex>`.
   */
  private verifyMeta(headers: Record<string, any>, rawBody: string | Buffer): boolean {
    const secret = process.env.META_APP_SECRET;
    if (!secret) return this.failOpen('META_APP_SECRET');

    const header = this.headerString(headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256']);
    if (!header || !header.startsWith('sha256=')) return false;
    const provided = header.slice('sha256='.length);
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return this.timingSafeEqual(provided, expected);
  }

  /**
   * Twilio signs with HMAC-SHA1 over the full request URL + sorted POST params,
   * base64-encoded, sent as `X-Twilio-Signature`. The controller must pass the
   * full request URL (including query string) and form-decoded params for this
   * to work end-to-end; here we only re-derive when both are present.
   */
  verifyTwilio(headers: Record<string, any>, fullUrl?: string, params?: Record<string, any>): boolean {
    const secret = process.env.TWILIO_AUTH_TOKEN;
    if (!secret) return this.failOpen('TWILIO_AUTH_TOKEN');
    if (!fullUrl || !params) return true; // controller may not have provided enough — allow

    const provided = this.headerString(headers['x-twilio-signature'] ?? headers['X-Twilio-Signature']);
    if (!provided) return false;

    const sortedKeys = Object.keys(params).sort();
    let payload = fullUrl;
    for (const k of sortedKeys) payload += k + String(params[k] ?? '');
    const expected = crypto.createHmac('sha1', secret).update(payload).digest('base64');
    return this.timingSafeEqual(provided, expected);
  }

  /**
   * Z-API signs with HMAC-SHA256 of the body using the per-instance token, sent
   * in a custom header. Z-API tokens are per-instance — for this base check we
   * use a global ZAPI_WEBHOOK_SECRET; channel-specific verification can be
   * layered later when per-instance tokens are wired in.
   */
  private verifyZapi(headers: Record<string, any>, rawBody: string | Buffer): boolean {
    const secret = process.env.ZAPI_WEBHOOK_SECRET;
    if (!secret) return this.failOpen('ZAPI_WEBHOOK_SECRET');
    const provided = this.headerString(headers['x-zapi-signature']);
    if (!provided) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return this.timingSafeEqual(provided, expected);
  }

  /**
   * Evolution API typically uses an `apikey` header carrying a shared secret.
   * Match against EVOLUTION_API_KEY.
   */
  private verifyEvolution(headers: Record<string, any>, _rawBody: string | Buffer): boolean {
    const secret = process.env.EVOLUTION_API_KEY;
    if (!secret) return this.failOpen('EVOLUTION_API_KEY');
    const provided = this.headerString(headers['apikey'] ?? headers['Apikey']);
    if (!provided) return false;
    return this.timingSafeEqual(provided, secret);
  }

  /**
   * Telegram uses the `X-Telegram-Bot-Api-Secret-Token` header (set when the
   * bot webhook was registered with `secret_token`). Compare to TELEGRAM_WEBHOOK_SECRET.
   */
  private verifyTelegram(headers: Record<string, any>): boolean {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return this.failOpen('TELEGRAM_WEBHOOK_SECRET');
    const provided = this.headerString(headers['x-telegram-bot-api-secret-token']);
    if (!provided) return false;
    return this.timingSafeEqual(provided, secret);
  }

  private timingSafeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  }

  private headerString(v: any): string {
    if (Array.isArray(v)) return String(v[0] ?? '');
    return v ? String(v) : '';
  }

  private failOpen(envVar: string): boolean {
    this.logger.warn(`${envVar} not set — allowing webhook through (DEV only; set in production)`);
    return true;
  }
}
