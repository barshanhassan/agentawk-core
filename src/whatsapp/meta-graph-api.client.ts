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
   * OAuth code → user access token exchange. Used during WhatsApp Embedded
   * Signup completion. Returns the long-lived user token Meta issues.
   */
  async exchangeCode(code: string): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
    const clientId = process.env.META_APP_ID;
    const clientSecret = process.env.META_APP_SECRET;
    if (!clientId || !clientSecret) {
      throw new BadRequestException('META_APP_ID and META_APP_SECRET must be set');
    }
    const url = `${this.base}/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&code=${encodeURIComponent(code)}`;
    const res = await fetch(url);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BadRequestException(`Meta OAuth: ${data?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return data;
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
      `/${phoneNumberId}?fields=id,verified_name,display_phone_number,code_verification_status,quality_rating,platform_type,throughput,last_onboarded_time`,
      accessToken,
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
