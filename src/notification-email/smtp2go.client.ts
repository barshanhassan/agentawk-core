import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * Thin client over the SMTP2GO v3 sender-domain API. Mirrors replyagent's
 * App\Libraries\SMTP2GO (domain/add, domain/verify, domain/view, domain/remove).
 *
 * The API key lives in SMTP2GO_API_KEY. When it's absent the client throws a
 * clear "not configured" error so the UI can surface it (same pattern as the
 * WhatsApp Meta integration) rather than silently failing.
 */
@Injectable()
export class Smtp2goClient {
  private readonly logger = new Logger(Smtp2goClient.name);
  private readonly base = 'https://api.smtp2go.com/v3';

  get isConfigured(): boolean {
    return !!process.env.SMTP2GO_API_KEY;
  }

  private async call(path: string, domain: string): Promise<any> {
    const apiKey = process.env.SMTP2GO_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        'Custom email domain is not configured on this server (SMTP2GO_API_KEY missing). ' +
          'Add the SMTP2GO API key to the backend environment to enable branded email.',
      );
    }
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ api_key: apiKey, domain }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.data?.error) {
      const msg =
        json?.data?.error ??
        json?.data?.field_validation_errors?.message ??
        `HTTP ${res.status}`;
      this.logger.warn(`SMTP2GO ${path} failed: ${msg}`);
      throw new BadRequestException(`SMTP2GO: ${msg}`);
    }
    return json;
  }

  addDomain(domain: string) {
    return this.call('/domain/add', domain);
  }

  verifyDomain(domain: string) {
    return this.call('/domain/verify', domain);
  }

  viewDomain(domain: string) {
    return this.call('/domain/view', domain);
  }

  removeDomain(domain: string) {
    return this.call('/domain/remove', domain);
  }

  /**
   * Flatten a SMTP2GO domain response into the columns we persist on
   * notification_emails. The sender domain object carries DKIM + Return-Path
   * (rpath) records; the first tracker carries the tracking CNAME.
   * Mirrors NotificationsController's field mapping (dkim_*, rpath_*, cname_*).
   */
  mapRecords(body: any): {
    request_id: string | null;
    dkim_expected: string | null;
    dkim_selector: string | null;
    dkim_verified: boolean;
    dkim_status: string | null;
    dkim_value: string | null;
    rpath_expected: string | null;
    rpath_selector: string | null;
    rpath_verified: boolean;
    rpath_status: string | null;
    rpath_value: string | null;
    cname_expected: string | null;
    cname_selector: string | null;
    cname_verified: boolean;
    cname_status: string | null;
    cname_value: string | null;
  } {
    const data = body?.data ?? {};
    const d = data.domain ?? {};
    const tracker = Array.isArray(data.trackers) ? data.trackers[0] : (data.tracker ?? null);
    return {
      request_id: body?.request_id ?? null,
      dkim_expected: d.dkim_expected ?? null,
      dkim_selector: d.dkim_selector ?? null,
      dkim_verified: !!d.dkim_verified,
      dkim_status: d.dkim_status ?? null,
      dkim_value: d.dkim_value ?? null,
      rpath_expected: d.rpath_expected ?? null,
      rpath_selector: d.rpath_selector ?? null,
      rpath_verified: !!d.rpath_verified,
      rpath_status: d.rpath_status ?? null,
      rpath_value: d.rpath_value ?? null,
      cname_expected: tracker?.cname_expected ?? null,
      cname_selector: tracker?.subdomain ?? null,
      cname_verified: tracker ? !!tracker.cname_verified : false,
      cname_status: tracker?.cname_status ?? null,
      cname_value: tracker?.cname_value ?? null,
    };
  }
}
