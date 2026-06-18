import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * Thin wrapper around Meta Graph API endpoints used by WhatsApp Cloud,
 * Instagram, and Messenger. Each method accepts the per-account `accessToken`
 * so multi-tenant calls don't share a global secret.
 *
 * Base version pinned to v20.0 — override with META_GRAPH_API_VERSION env var.
 */
@Injectable()
export class MetaGraphApiClient {
  private readonly logger = new Logger(MetaGraphApiClient.name);
  private readonly base = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? 'v20.0'}`;

  // ─── WhatsApp Cloud ─────────────────────────────────────────────────

  /**
   * Send a WhatsApp message. `body` follows Meta's documented schema:
   *   { messaging_product: 'whatsapp', to, type, text?, template?, image?, ... }
   * The caller composes the type-specific subfield.
   */
  async sendWhatsappMessage(phoneNumberId: string, accessToken: string, body: any) {
    return this.request<{ messaging_product: string; contacts: any[]; messages: { id: string }[] }>(
      'POST',
      `/${phoneNumberId}/messages`,
      accessToken,
      body,
    );
  }

  async fetchPhoneNumberProfile(phoneNumberId: string, accessToken: string) {
    return this.request(
      'GET',
      `/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
      accessToken,
    );
  }

  async updatePhoneNumberProfile(phoneNumberId: string, accessToken: string, profile: any) {
    return this.request(
      'POST',
      `/${phoneNumberId}/whatsapp_business_profile`,
      accessToken,
      { messaging_product: 'whatsapp', ...profile },
    );
  }

  /** Fetch all message templates for a WABA. Paginates if needed. */
  async fetchTemplates(wabaId: string, accessToken: string) {
    const all: any[] = [];
    let after: string | undefined;
    let safety = 0;
    do {
      const qs = after ? `&after=${encodeURIComponent(after)}` : '';
      const page = await this.request<{ data: any[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        'GET',
        `/${wabaId}/message_templates?limit=100&fields=name,id,category,status,language,components,quality_score${qs}`,
        accessToken,
      );
      all.push(...(page.data ?? []));
      after = page.paging?.next ? page.paging?.cursors?.after : undefined;
      safety++;
    } while (after && safety < 50);
    return all;
  }

  async deleteTemplate(wabaId: string, accessToken: string, templateName: string) {
    return this.request(
      'DELETE',
      `/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`,
      accessToken,
    );
  }

  /**
   * OAuth code → long-lived user access token exchange. Used during WhatsApp
   * Embedded Signup completion.
   *
   * Two-step: first exchange the short-lived code for a short-lived token,
   * then immediately upgrade it to a long-lived token (~60 days) so we are
   * not stuck with a 1-hour window. The long-lived token is what gets stored
   * in wa_accounts.access_token and forwarded to the microservice.
   */
  async exchangeCode(code: string): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
    const clientId = process.env.META_APP_ID;
    const clientSecret = process.env.META_APP_SECRET;
    if (!clientId || !clientSecret) {
      throw new BadRequestException('META_APP_ID and META_APP_SECRET must be set');
    }

    // Step 1 — short-lived token
    const shortUrl = `${this.base}/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&code=${encodeURIComponent(code)}`;
    const shortRes = await fetch(shortUrl);
    const shortData: any = await shortRes.json().catch(() => ({}));
    if (!shortRes.ok) {
      throw new BadRequestException(`Meta OAuth (code exchange): ${shortData?.error?.message ?? `HTTP ${shortRes.status}`}`);
    }
    const shortToken: string = shortData.access_token;
    if (!shortToken) throw new BadRequestException('Meta did not return access_token during code exchange');

    // Step 2 — upgrade to long-lived token (~60 days)
    try {
      const longUrl = `${this.base}/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${encodeURIComponent(shortToken)}`;
      const longRes = await fetch(longUrl);
      const longData: any = await longRes.json().catch(() => ({}));
      if (longRes.ok && longData.access_token) {
        return longData;
      }
      this.logger.warn(`Long-lived token upgrade failed (${longRes.status}): ${longData?.error?.message ?? 'unknown'}; using short-lived token`);
    } catch (e: any) {
      this.logger.warn(`Long-lived token upgrade threw: ${e?.message ?? e}; using short-lived token`);
    }

    return shortData;
  }

  async fetchWabaAccount(wabaId: string, accessToken: string) {
    return this.request<any>(
      'GET',
      `/${wabaId}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status,is_enabled_for_insights,on_behalf_of_business_info,ownership_type`,
      accessToken,
    );
  }

  async fetchPhoneNumberDetails(phoneNumberId: string, accessToken: string) {
    return this.request<any>(
      'GET',
      `/${phoneNumberId}?fields=id,verified_name,display_phone_number,code_verification_status,quality_rating,platform_type,throughput,messaging_limit_tier,last_onboarded_time`,
      accessToken,
    );
  }

  /**
   * Register a WhatsApp phone number on Cloud API with a 6-digit two-step
   * verification PIN. Mirrors replyagent's `registerNumber()`
   * (gateway/app/Traits/WhatsappTrait.php:267) which posts to
   * `POST /{phone_number_id}/register` with `{ messaging_product, pin }`.
   *
   * Registration is what flips a number from "added to the WABA" to
   * "able to send/receive on Cloud API". The PIN doubles as the number's
   * two-step verification code (re-used if Meta later prompts for it).
   */
  async registerPhoneNumber(phoneNumberId: string, accessToken: string, pin: string) {
    return this.request<{ success?: boolean; error?: any }>(
      'POST',
      `/${phoneNumberId}/register`,
      accessToken,
      { messaging_product: 'whatsapp', pin },
    );
  }

  /**
   * Update (or set) the two-step verification PIN on an already-registered
   * number. Meta exposes this as `POST /{phone_number_id}` with `{ pin }`.
   * Used when the admin changes the PIN from the manage view.
   */
  async setTwoStepPin(phoneNumberId: string, accessToken: string, pin: string) {
    return this.request<{ success?: boolean; error?: any }>(
      'POST',
      `/${phoneNumberId}`,
      accessToken,
      { pin },
    );
  }

  async fetchPhoneNumbersForWaba(wabaId: string, accessToken: string) {
    return this.request<{ data: any[] }>(
      'GET',
      `/${wabaId}/phone_numbers?fields=id,verified_name,display_phone_number,code_verification_status,quality_rating,platform_type`,
      accessToken,
    );
  }

  /** Subscribe our app to a WABA's webhook events. Required for inbound. */
  async subscribeWabaWebhook(wabaId: string, accessToken: string) {
    return this.request('POST', `/${wabaId}/subscribed_apps`, accessToken);
  }

  /**
   * Debug the token — returns Meta's introspection result. Requires the app's
   * own access token (built as `app_id|app_secret`) so the call is authorized
   * to inspect arbitrary user tokens.
   *
   * Response shape (relevant fields):
   *   data: { is_valid, type: 'USER' | 'SYSTEM_USER' | 'PAGE',
   *           expires_at: 0 | <unix-seconds>, // 0 means no expiry (System User)
   *           data_access_expires_at, scopes, app_id, application, user_id }
   *
   * Throws BadRequestException when META_APP_ID/SECRET are not configured.
   */
  async debugToken(token: string): Promise<{
    isValid: boolean;
    type?: string;
    expiresAt?: number;
    dataAccessExpiresAt?: number;
    scopes?: string[];
    appId?: string;
    application?: string;
    error?: string;
  }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new BadRequestException('META_APP_ID and META_APP_SECRET must be set to debug tokens');
    }
    const appToken = `${appId}|${appSecret}`;
    const url = `${this.base}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`;
    const res = await fetch(url);
    const json: any = await res.json().catch(() => ({}));

    if (!res.ok || !json?.data) {
      return {
        isValid: false,
        error: json?.error?.message ?? `HTTP ${res.status}`,
      };
    }
    const d = json.data;
    return {
      isValid: d.is_valid === true,
      type: d.type,
      expiresAt: d.expires_at ?? undefined,
      dataAccessExpiresAt: d.data_access_expires_at ?? undefined,
      scopes: d.scopes ?? [],
      appId: d.app_id,
      application: d.application,
      error: d.error?.message,
    };
  }

  /**
   * Quick validation used at onboard time — fetch the phone number details.
   * Returns true if the (access_token, phone_number_id) pair works against
   * Meta. Used to fail fast in onboardManual before persisting/publishing.
   */
  async validatePhoneNumberAccess(phoneNumberId: string, accessToken: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.fetchPhoneNumberDetails(phoneNumberId, accessToken);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  // ─── Instagram / Messenger (Pages API) ──────────────────────────────

  /** Send DM via Instagram/Messenger using the Page's `me/messages` endpoint. */
  async sendMessengerMessage(pageAccessToken: string, body: { recipient: { id: string }; message: any }) {
    return this.request('POST', `/me/messages`, pageAccessToken, body);
  }

  async fetchPages(userAccessToken: string) {
    return this.request<{ data: any[] }>(
      'GET',
      `/me/accounts?fields=id,name,access_token,instagram_business_account,category`,
      userAccessToken,
    );
  }

  // ─── Core HTTP wrapper ──────────────────────────────────────────────

  private async request<T = any>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    accessToken: string,
    body?: any,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const msg = parsed?.error?.message ?? parsed?.message ?? `HTTP ${res.status}`;
      this.logger.warn(`Meta Graph ${method} ${path} → ${res.status}: ${msg}`);
      throw new BadRequestException(`Meta Graph API: ${msg}`);
    }
    return parsed as T;
  }
}
