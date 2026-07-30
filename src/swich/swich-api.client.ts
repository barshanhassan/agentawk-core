import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export type SwichEnvironment = 'sandbox' | 'production';

export interface SwichCredentials {
  clientId: string;
  clientSecret: string;
  environment: SwichEnvironment;
  checksumSecret?: string | null;
  aesEncryptionKey?: string | null;
}

/**
 * Thin wrapper around the Swich PayIn API (per "Swich PayIn 2.0 Integration
 * Guide"). Every method takes credentials + an access token explicitly so
 * calls stay multi-tenant (no shared/global secret) — mirrors
 * MetaGraphApiClient's shape.
 *
 * Base URLs (Section 3 of the guide):
 *   API:     sandbox-api.swichnow.com        / api.swichnow.com
 *   Auth:    sandbox-auth.swichnow.com        / auth.swichnow.com
 *   Landing (GET):  sandbox-payin-pwa.swichnow.com   / payin-pwa.swichnow.com
 *   Landing (POST): sandbox-payinpwa20.swichnow.com  / payin2pwa.swichnow.com
 */
@Injectable()
export class SwichApiClient {
  private readonly logger = new Logger(SwichApiClient.name);

  private apiBase(env: SwichEnvironment) {
    return env === 'production' ? 'https://api.swichnow.com' : 'https://sandbox-api.swichnow.com';
  }
  private authBase(env: SwichEnvironment) {
    return env === 'production' ? 'https://auth.swichnow.com' : 'https://sandbox-auth.swichnow.com';
  }
  private landingGetBase(env: SwichEnvironment) {
    return env === 'production' ? 'https://payin-pwa.swichnow.com' : 'https://sandbox-payin-pwa.swichnow.com';
  }
  private landingPostBase(env: SwichEnvironment) {
    return env === 'production'
      ? 'https://payin2pwa.swichnow.com/Transaction/Index'
      : 'https://sandbox-payinpwa20.swichnow.com/Transaction/Index';
  }

  // ─── Section 4: Bearer Token ────────────────────────────────────────

  /** POST {authBase}/connect/token — client_credentials grant. */
  async getAccessToken(
    clientId: string,
    clientSecret: string,
    environment: SwichEnvironment,
  ): Promise<{ access_token: string; token_type: string; expires_in: number }> {
    const url = `${this.authBase(environment)}/connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const parsed = await this.parseBody(res);
    if (!res.ok) {
      throw new Error(
        `Swich token request failed (${res.status}): ${parsed?.error_description || parsed?.error || 'unknown error'}`,
      );
    }
    return parsed;
  }

  // ─── Section 5.2 / 6.2: Checksum ────────────────────────────────────

  /** Swich:customer_transaction_id:item:amount, HMAC-SHA256 with SecretKey. */
  buildChecksum(secretKey: string, customerTransactionId: string, item: string, amount: string | number): string {
    const plain = `Swich:${customerTransactionId}:${item}:${amount}`;
    return crypto.createHmac('sha256', secretKey).update(plain).digest('hex');
  }

  /** Section 16: SWCallback:CustomerTransactionId:OrderId:Amount:Status */
  buildCallbackChecksum(
    secretKey: string,
    customerTransactionId: string,
    orderId: string,
    amount: string | number,
    status: string,
  ): string {
    const plain = `SWCallback:${customerTransactionId}:${orderId}:${amount}:${status}`;
    return crypto.createHmac('sha256', secretKey).update(plain).digest('hex');
  }

  // ─── Section 5: Landing Page / PWA (GET) ────────────────────────────

  /** Builds the redirect URL — frontend opens this directly (no API call). */
  buildLandingPageGetUrl(environment: SwichEnvironment, clientId: string, params: Record<string, any>): string {
    const qp = new URLSearchParams({ clientId, ...this.stringifyParams(params) });
    return `${this.landingGetBase(environment)}/?${qp.toString()}`;
  }

  // ─── Section 6: Landing Page / PWA (POST) ───────────────────────────

  /**
   * AES-256-CBC encrypts the params JSON into the `Token` field per Section
   * 6.1 ("Aes encryption algorithm has been used. Keys will be shared by
   * Swich upon integration"). `aesEncryptionKey` must be the key Swich gave
   * this merchant — distinct from client_secret.
   */
  buildLandingPagePostPayload(environment: SwichEnvironment, clientId: string, aesEncryptionKey: string, params: Record<string, any>) {
    const json = JSON.stringify({ ClientId: clientId, ...params });
    const key = crypto.createHash('sha256').update(aesEncryptionKey).digest(); // 32 bytes for AES-256
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const token = Buffer.concat([iv, encrypted]).toString('base64');
    return { url: this.landingPostBase(environment), clientId, token };
  }

  // ─── Section 7: E-Wallet Payin ───────────────────────────────────────

  purchaseEwallet(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/ewallet', body);
  }

  // ─── Section 8: Biller Payin (1Bill) ─────────────────────────────────

  purchaseBiller(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/biller', body);
  }

  // ─── Section 9: Bank Payin ────────────────────────────────────────────

  getBanks(environment: SwichEnvironment, accessToken: string) {
    return this.request(environment, accessToken, 'GET', '/gateway/payin/get/banks');
  }

  bankOtp(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/bank/otp', body);
  }

  bankTransfer(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/bank/transfer', body);
  }

  // ─── Section 10: QR Payin ─────────────────────────────────────────────

  qrGenerate(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/qr/dynamic', body);
  }

  qrCancel(environment: SwichEnvironment, accessToken: string, customerTransactionId: string) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/qr/dynamic/cancel', {
      customerTransactionId,
    });
  }

  qrInquire(environment: SwichEnvironment, accessToken: string, customerTransactionId: string) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/qr/dynamic/inquire', {
      customerTransactionId,
    });
  }

  // ─── Section 11: RTP (RAAST) ──────────────────────────────────────────

  rtpTitle(environment: SwichEnvironment, accessToken: string, query: Record<string, any>) {
    const qp = new URLSearchParams(this.stringifyParams(query));
    return this.request(environment, accessToken, 'GET', `/gateway/payin/v2.0/purchase/rtp/title?${qp.toString()}`);
  }

  rtpNowBankList(environment: SwichEnvironment, accessToken: string) {
    return this.request(environment, accessToken, 'GET', '/gateway/payin/v2.0/rtp/now/get/banks');
  }

  rtpNow(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/rtp/now', body);
  }

  rtpLaterBankList(environment: SwichEnvironment, accessToken: string) {
    return this.request(environment, accessToken, 'GET', '/gateway/payin/v2.0/rtp/later/get/banks');
  }

  rtpLater(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/rtp/later', body);
  }

  rtpCancel(environment: SwichEnvironment, accessToken: string, customerTransactionId: string) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/rtp/cancel', {
      CustomerTransactionId: customerTransactionId,
    });
  }

  rtpInquire(environment: SwichEnvironment, accessToken: string, customerTransactionId: string) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/rtp/inquire', {
      CustomerTransactionId: customerTransactionId,
    });
  }

  // ─── Section 12/13: Inquire (generic) ─────────────────────────────────

  inquire(environment: SwichEnvironment, accessToken: string, customerTransactionId: string) {
    const qp = new URLSearchParams({ CustomerTransactionId: customerTransactionId });
    return this.request(environment, accessToken, 'GET', `/gateway/payin/v2.0/inquire?${qp.toString()}`);
  }

  // ─── Section 14: Refund ────────────────────────────────────────────────

  refund(environment: SwichEnvironment, accessToken: string, body: { OrderId: string; Reason: string; Amount: number }) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/refund', body);
  }

  // ─── Section 15: Recurring Card Payment ───────────────────────────────

  getRecurringInstrument(environment: SwichEnvironment, accessToken: string, msisdn: string) {
    const qp = new URLSearchParams({ msisdn });
    return this.request(
      environment,
      accessToken,
      'GET',
      `/gateway/payin/v2.0/purchase/card/recurring/instrument?${qp.toString()}`,
    );
  }

  initiateRecurringCardPayment(environment: SwichEnvironment, accessToken: string, body: any) {
    return this.request(environment, accessToken, 'POST', '/gateway/payin/v2.0/purchase/card/recurring', body);
  }

  // ─── Shared helpers ────────────────────────────────────────────────────

  private async request(environment: SwichEnvironment, accessToken: string, method: 'GET' | 'POST', path: string, body?: any) {
    const url = `${this.apiBase(environment)}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = await this.parseBody(res);
    // Swich returns structured {status:"failed", code, message} bodies with
    // 400/401/500/502 — surface those as-is rather than throwing, so callers
    // (SwichService) can persist the failure reason instead of losing it to
    // a generic HTTP exception.
    if (!res.ok) {
      this.logger.warn(`Swich ${method} ${path} -> ${res.status}: ${parsed?.message ?? JSON.stringify(parsed)}`);
    }
    return { httpStatus: res.status, ok: res.ok, data: parsed };
  }

  private async parseBody(res: Response): Promise<any> {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return { raw: text };
    }
  }

  private stringifyParams(params: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      out[k] = String(v);
    }
    return out;
  }
}
