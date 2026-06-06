import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Signs OUTBOUND webhook deliveries so the customer's endpoint can verify
 * the payload came from us. We derive a per-webhook secret from
 * `EZCONN_WEBHOOK_SIGNING_KEY` + the webhook id — that way the customer
 * doesn't need to handle per-webhook secret rotation and the column on
 * `webhooks` stays empty (E2 scope keeps schema changes to a single
 * column).
 *
 * Header: `X-Ezconn-Signature: t=<unix>,v1=<hex>` where:
 *   - `t` is the unix timestamp we signed at (replay protection)
 *   - `v1` is HMAC-SHA256(`<t>.<body>`, derivedSecret)
 *
 * Customers verify by re-computing v1 and rejecting if t is older than a
 * tolerance window (5 minutes is the Stripe-style default). This is
 * documented in the API docs so integrators know the format.
 *
 * Note: This is DIFFERENT from `webhook-signature.service.ts`, which
 * verifies INBOUND signatures from Meta/Twilio/Z-API etc.
 */
@Injectable()
export class OutboundWebhookSignatureService {
  /**
   * Returns the `X-Ezconn-Signature` header value for the given body. If
   * `EZCONN_WEBHOOK_SIGNING_KEY` is unset (e.g. local dev), returns a
   * `sig=disabled` marker so the customer's endpoint can detect dev
   * traffic and skip verification.
   */
  sign(webhookId: bigint, body: string): string {
    const masterSecret = process.env.EZCONN_WEBHOOK_SIGNING_KEY;
    if (!masterSecret) {
      return 'sig=disabled';
    }
    const derivedSecret = crypto
      .createHmac('sha256', masterSecret)
      .update(String(webhookId))
      .digest('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = crypto
      .createHmac('sha256', derivedSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return `t=${timestamp},v1=${signed}`;
  }
}
