import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * Thin wrapper around Meta Graph API endpoints used by WhatsApp Cloud,
 * Instagram, and Messenger. Each method accepts the per-account `accessToken`
 * so multi-tenant calls don't share a global secret.
 *
 * Base version pinned to v21.0 — override with META_GRAPH_API_VERSION env var.
 */
@Injectable()
export class MetaGraphApiClient {
  private readonly logger = new Logger(MetaGraphApiClient.name);
  // Default aligned to v21.0 to match the microservice's Graph version (BE-direct
  // calls were defaulting to v20.0). Override with META_GRAPH_API_VERSION.
  private readonly base = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? 'v21.0'}`;

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

  /**
   * Trigger a WhatsApp Business App (Coexistence) state sync. Meta then delivers
   * the connected business phone's existing contacts asynchronously via an
   * `smb_app_state_sync` webhook. This is the Coex equivalent of number
   * registration — Coex numbers are NOT `/register`'d. Mirrors replyagent
   * WhatsappTrait::synchronizeNumber (POST `{id}/smb_app_data`).
   */
  async smbAppData(phoneNumberId: string, accessToken: string, syncType = 'smb_app_state_sync') {
    return this.request(
      'POST',
      `/${phoneNumberId}/smb_app_data`,
      accessToken,
      { messaging_product: 'whatsapp', sync_type: syncType },
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

  /**
   * Delete a message template. Passing `hsm_id` (the Meta template id) narrows
   * the delete to that ONE language variant — name-only deletes every language
   * registered under that name, which is rarely what the user clicked. Mirrors
   * replyagent's `?hsm_id=…&name=…`.
   */
  async deleteTemplate(
    wabaId: string,
    accessToken: string,
    templateName: string,
    hsmId?: string | null,
  ) {
    const qs = new URLSearchParams({ name: templateName });
    if (hsmId) qs.set('hsm_id', String(hsmId));
    return this.request('DELETE', `/${wabaId}/message_templates?${qs.toString()}`, accessToken);
  }

  /**
   * Create a message template on Meta. `payload` follows Meta's documented
   * schema: { name, language, category, components: [...] }. Meta returns
   * { id, status, category } — the template starts in PENDING review.
   */
  async createTemplate(wabaId: string, accessToken: string, payload: any) {
    return this.request<{ id: string; status?: string; category?: string }>(
      'POST',
      `/${wabaId}/message_templates`,
      accessToken,
      payload,
    );
  }

  /**
   * Edit an existing template (resubmit for approval). Meta's edit endpoint is
   * POST directly on the template id; only `components` (and `category`) can
   * change — name and language are immutable. Mirrors replyagent
   * WhatsappTrait::updateWhatsappTemplate.
   */
  async updateTemplate(templateMetaId: string, accessToken: string, payload: any) {
    return this.request(
      'POST',
      `/${templateMetaId}`,
      accessToken,
      payload,
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
    // name_status + new_name_status are required by reconnectNumber's display-name
    // override (replyagent parity); without them in the fields list Meta omits
    // them and the override never fires. new_name_status is transient (not stored).
    return this.request<any>(
      'GET',
      `/${phoneNumberId}?fields=id,verified_name,display_phone_number,code_verification_status,quality_rating,name_status,new_name_status,platform_type,throughput,messaging_limit_tier,last_onboarded_time`,
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

  /**
   * Upload a media file to Meta and return the opaque **header handle** that a
   * template's `HEADER` component needs in `example.header_handle[0]`.
   *
   * Mirrors replyagent `WhatsappTrait::uploadMedia()` (gateway line 362). Two steps:
   *   1. `POST /{app_id}/uploads?...` opens a resumable session and returns `{id}`.
   *      For a MEDIA_TEMPLATE the file descriptors also ride in the query string;
   *      for a CAROUSEL_CARD only the access token does. That asymmetry is
   *      replyagent's, and Meta accepts both, so it is preserved.
   *   2. `POST /{session_id}` with the raw bytes, `Authorization: OAuth <token>`
   *      and `file_offset: 0`, returns `{h: "<handle>"}`.
   *
   * The token is the APP system-user token (`WA_SYSTEM_USER`), not the WABA's
   * access token — uploads belong to the app, not the business account.
   *
   * Returns the handle string, or null when any step fails (callers surface that
   * to the UI as a retryable "TRY_AGAIN").
   */
  async uploadTemplateMedia(
    file: { file_length: number; mime_type: string; file_name: string; file_url: string },
    systemUserToken: string,
    templateType: 'MEDIA_TEMPLATE' | 'CAROUSEL_CARD' = 'MEDIA_TEMPLATE',
  ): Promise<string | null> {
    const appId = process.env.META_APP_ID ?? process.env.FB_APP_ID;
    if (!appId) {
      this.logger?.warn?.('uploadTemplateMedia: META_APP_ID / FB_APP_ID is not configured');
      return null;
    }
    try {
      // ── Step 1: open the upload session ──
      const qs = new URLSearchParams({ access_token: systemUserToken });
      if (templateType === 'MEDIA_TEMPLATE') {
        qs.set('file_length', String(file.file_length));
        qs.set('file_type', file.mime_type);
        qs.set('file_name', file.file_name);
      }
      const sessionRes = await fetch(`${this.base}/${appId}/uploads?${qs.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_length: file.file_length,
          file_type: file.mime_type,
          file_name: file.file_name,
        }),
      });
      const session: any = await sessionRes.json().catch(() => null);
      if (!session?.id) {
        this.logger?.warn?.(
          `uploadTemplateMedia: session create failed — ${JSON.stringify(session ?? {})}`,
        );
        return null;
      }

      // ── Step 2: stream the bytes ──
      // The media lives on our own S3/CDN, so this is an unauthenticated GET.
      const binRes = await fetch(file.file_url);
      if (!binRes.ok) {
        this.logger?.warn?.(`uploadTemplateMedia: could not read ${file.file_url} (${binRes.status})`);
        return null;
      }
      const bytes = Buffer.from(await binRes.arrayBuffer());

      const uploadRes = await fetch(`${this.base}/${session.id}`, {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${systemUserToken}`,
          file_offset: '0',
          'Content-Type': 'application/octet-stream',
        },
        body: bytes as any,
      });
      const uploaded: any = await uploadRes.json().catch(() => null);
      if (!uploaded?.h) {
        this.logger?.warn?.(
          `uploadTemplateMedia: upload failed — ${JSON.stringify(uploaded ?? {})}`,
        );
        return null;
      }
      return String(uploaded.h);
    } catch (e: any) {
      this.logger?.warn?.(`uploadTemplateMedia threw: ${e?.message ?? e}`);
      return null;
    }
  }

  async fetchPhoneNumbersForWaba(wabaId: string, accessToken: string) {
    return this.request<{ data: any[] }>(
      'GET',
      `/${wabaId}/phone_numbers?fields=id,verified_name,display_phone_number,code_verification_status,quality_rating,platform_type`,
      accessToken,
    );
  }

  /**
   * Subscribe our app to a WABA's webhook events. Required for inbound.
   *
   * DELIBERATELY a bare subscribe (no `override_callback_uri`). Meta must
   * deliver to the APP-LEVEL webhook, which is the `agentawk-meta` microservice
   * (`/api/whatsapp-hook`) → RabbitMQ `ra/gateway` → `whatsapp-events.consumer`.
   * That consumer is the only path that downloads media/voice to S3, handles
   * emoji reactions and stickers, and emits the realtime socket events.
   *
   * A per-WABA `override_callback_uri` was added in b37b110 and reverted here:
   * it re-routed inbound to `/webhooks-inbound/whatsapp`, whose parser has none
   * of the above, so media, voice notes, stickers, reactions and realtime all
   * went dead. Do NOT re-add it until that parser is at full parity.
   */
  async subscribeWabaWebhook(wabaId: string, accessToken: string) {
    return this.request('POST', `/${wabaId}/subscribed_apps`, accessToken);
  }

  /**
   * Unsubscribe our app from a WABA's webhooks. Mirrors replyagent
   * WhatsappTrait::unSubscribe() — `DELETE {waba_id}/subscribed_apps`. Fired on
   * account delete so Meta stops delivering that WABA's events to our app.
   */
  async unsubscribeWabaWebhook(wabaId: string, accessToken: string) {
    return this.request('DELETE', `/${wabaId}/subscribed_apps`, accessToken);
  }

  /**
   * Deregister a phone number from the Cloud API. Mirrors replyagent
   * WhatsappTrait::deRegisterNumber() — `POST {phone_number_id}/deregister`.
   * Fired on both single-number delete and account delete so the number is
   * released on Meta's side and can be re-onboarded later.
   */
  async deregisterPhoneNumber(phoneNumberId: string, accessToken: string) {
    return this.request('POST', `/${phoneNumberId}/deregister`, accessToken);
  }

  /**
   * Mint (or fetch) the Conversions-API dataset bound to a WABA. Mirrors
   * replyagent CapiController::getWhatsappDataset() — `POST {waba_id}/dataset`
   * with an EMPTY body, authorized with the account's own access token. Meta
   * returns `{ id }` where `id` is the dataset_id we persist. Idempotent on
   * Meta's side — calling again returns the same dataset id.
   */
  async createDataset(wabaId: string, accessToken: string): Promise<{ id?: string }> {
    return this.request('POST', `/${wabaId}/dataset`, accessToken);
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
      const err = parsed?.error ?? {};
      // Meta buries the useful reason in error_user_msg / error_data.details;
      // the top-level `message` is often just "Invalid parameter".
      const detail =
        err.error_user_msg ||
        err.error_data?.details ||
        err.message ||
        parsed?.message ||
        `HTTP ${res.status}`;
      const msg =
        err.error_user_title && err.error_user_title !== detail
          ? `${err.error_user_title}: ${detail}`
          : detail;
      this.logger.warn(
        `Meta Graph ${method} ${path} → ${res.status}: ${JSON.stringify(err).slice(0, 400)}`,
      );
      throw new BadRequestException(`Meta: ${msg}`);
    }
    return parsed as T;
  }
}
