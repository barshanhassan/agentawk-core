import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SwichApiClient, SwichEnvironment } from './swich-api.client';
import { InvoicesService } from '../invoices/invoices.service';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/** A Swich account/transaction belongs to exactly one of these. */
export interface SwichOwner {
  workspaceId?: bigint;
  agencyId?: bigint;
}

/**
 * Business layer for Swich PayIn: owns credential storage (per workspace OR
 * per agency — e.g. the agency's own Billing/Plans checkout uses agency-
 * scoped credentials, separate from any tenant workspace's), Bearer-token
 * caching (Section 4), checksum signing (Section 5.2/16), and local
 * bookkeeping of every customerTransactionId we create so the public
 * callback (Section 16) and Inquire API (Section 13) have something to
 * reconcile against. SwichApiClient stays a pure, credential-in/response-out
 * HTTP wrapper — all Prisma access lives here.
 */
@Injectable()
export class SwichService {
  private readonly logger = new Logger(SwichService.name);
  // In-memory token cache. Multi-instance deployments would need this in
  // Redis, but the rest of this app doesn't do that for comparable per-tenant
  // tokens (e.g. Meta) either — matching existing convention.
  private readonly tokenCache = new Map<string, CachedToken>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: SwichApiClient,
    private readonly invoices: InvoicesService,
  ) {}

  // ─── Credentials ─────────────────────────────────────────────────────

  private ownerWhere(owner: SwichOwner) {
    if (owner.agencyId != null) return { agency_id: owner.agencyId, status: 'ACTIVE' };
    if (owner.workspaceId != null) return { workspace_id: owner.workspaceId, status: 'ACTIVE' };
    throw new BadRequestException('Swich owner (workspace or agency) is required');
  }

  private ownerCacheKey(owner: SwichOwner) {
    return owner.agencyId != null ? `agency:${owner.agencyId}` : `workspace:${owner.workspaceId}`;
  }

  /**
   * The Agency's own Billing/Plans checkout charges agencies on behalf of
   * Agentawk itself (Agentawk is the merchant, agencies are the payers) — so
   * unlike per-workspace credentials, there's exactly one Agentawk-wide
   * Swich account, held in server config rather than a per-tenant DB row.
   */
  private getEnvAccount() {
    const clientId = process.env.SWICH_CLIENT_ID;
    const clientSecret = process.env.SWICH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new BadRequestException('Swich is not configured on the server yet.');
    }
    return {
      id: null as bigint | null,
      client_id: clientId,
      client_secret: clientSecret,
      pwa_client_id: process.env.SWICH_PWA_CLIENT_ID || clientId,
      pwa_client_secret: process.env.SWICH_PWA_CLIENT_SECRET || null,
      checksum_secret: process.env.SWICH_CHECKSUM_SECRET || null,
      aes_encryption_key: process.env.SWICH_AES_ENCRYPTION_KEY || null,
      environment: (process.env.SWICH_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production') as SwichEnvironment,
      status: 'ACTIVE',
      updated_at: null as Date | null,
    };
  }

  async getAccount(owner: SwichOwner) {
    if (owner.agencyId != null) return this.getEnvAccount();

    const account = await this.prisma.swich_accounts.findFirst({
      where: this.ownerWhere(owner),
      orderBy: { id: 'desc' },
    });
    if (!account) {
      throw new BadRequestException('Swich is not connected yet. Add your client_id/client_secret first.');
    }
    return account;
  }

  /** Masked — safe to return to the frontend (never echoes secrets back). */
  async getAccountSummary(owner: SwichOwner) {
    if (owner.agencyId != null) {
      if (!process.env.SWICH_CLIENT_ID || !process.env.SWICH_CLIENT_SECRET) return { connected: false };
      const account = this.getEnvAccount();
      return {
        connected: true,
        environment: account.environment,
        client_id: account.client_id,
        has_pwa_credentials: !!process.env.SWICH_PWA_CLIENT_ID,
        pwa_client_id: account.pwa_client_id,
        has_checksum_secret: !!account.checksum_secret,
        has_aes_key: !!account.aes_encryption_key,
        updated_at: null,
      };
    }

    const account = await this.prisma.swich_accounts.findFirst({
      where: this.ownerWhere(owner),
      orderBy: { id: 'desc' },
    });
    if (!account) return { connected: false };
    return {
      connected: true,
      environment: account.environment,
      client_id: account.client_id,
      has_pwa_credentials: !!account.pwa_client_id,
      pwa_client_id: account.pwa_client_id,
      has_checksum_secret: !!account.checksum_secret,
      has_aes_key: !!account.aes_encryption_key,
      updated_at: account.updated_at,
    };
  }

  async saveCredentials(
    owner: SwichOwner,
    data: {
      client_id: string;
      client_secret: string;
      environment?: SwichEnvironment;
      pwa_client_id?: string;
      pwa_client_secret?: string;
      checksum_secret?: string;
      aes_encryption_key?: string;
    },
  ) {
    if (owner.agencyId != null) {
      throw new BadRequestException('Agency-level Swich credentials are configured on the server (.env), not editable here.');
    }
    const existing = await this.prisma.swich_accounts.findFirst({ where: this.ownerWhere(owner) });

    // First-time connect requires the core API pair; updates may leave any
    // field blank to keep its current stored value (matches the "leave
    // blank to keep current" placeholders in the frontend — e.g. changing
    // just the environment shouldn't force retyping every secret).
    if (!existing && (!data.client_id?.trim() || !data.client_secret?.trim())) {
      throw new BadRequestException('client_id and client_secret are required');
    }

    const environment: SwichEnvironment = data.environment === 'production' ? 'production' : 'sandbox';
    // Validated above: either `existing` has these, or the fresh values were required.
    const clientId = (data.client_id?.trim() || existing?.client_id) as string;
    const clientSecret = (data.client_secret?.trim() || existing?.client_secret) as string;

    const payload = {
      workspace_id: owner.workspaceId ?? null,
      agency_id: owner.agencyId ?? null,
      environment,
      client_id: clientId,
      client_secret: clientSecret,
      pwa_client_id: data.pwa_client_id?.trim() || existing?.pwa_client_id || null,
      pwa_client_secret: data.pwa_client_secret?.trim() || existing?.pwa_client_secret || null,
      checksum_secret: data.checksum_secret?.trim() || existing?.checksum_secret || null,
      aes_encryption_key: data.aes_encryption_key?.trim() || existing?.aes_encryption_key || null,
      status: 'ACTIVE',
      updated_at: new Date(),
    };

    if (existing) {
      await this.prisma.swich_accounts.update({ where: { id: existing.id }, data: payload });
    } else {
      await this.prisma.swich_accounts.create({ data: { ...payload, created_at: new Date() } });
    }

    // Credentials changed — drop any cached token for this owner.
    this.tokenCache.delete(this.ownerCacheKey(owner));

    return this.getAccountSummary(owner);
  }

  async removeCredentials(owner: SwichOwner) {
    if (owner.agencyId != null) {
      throw new BadRequestException('Agency-level Swich credentials are configured on the server (.env), not editable here.');
    }
    const account = await this.prisma.swich_accounts.findFirst({ where: this.ownerWhere(owner) });
    if (!account) throw new NotFoundException('Swich is not connected');
    await this.prisma.swich_accounts.update({ where: { id: account.id }, data: { status: 'REMOVED' } });
    this.tokenCache.delete(this.ownerCacheKey(owner));
    return { success: true };
  }

  // ─── Bearer token (Section 4) ────────────────────────────────────────

  private async getAccessToken(owner: SwichOwner, account: { client_id: string; client_secret: string; environment: string }) {
    const key = this.ownerCacheKey(owner);
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 5000) return cached.accessToken;

    const env = account.environment as SwichEnvironment;
    const res = await this.client.getAccessToken(account.client_id, account.client_secret, env);
    // 60s safety margin so we never hand out a token that expires mid-call.
    const expiresAt = Date.now() + Math.max(0, (res.expires_in - 60) * 1000);
    this.tokenCache.set(key, { accessToken: res.access_token, expiresAt });
    return res.access_token;
  }

  // ─── Transaction bookkeeping ──────────────────────────────────────────

  /** Merchant-generated, ≤50 chars per spec — timestamp + random for uniqueness. */
  generateCustomerTransactionId(): string {
    return `AGW${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.slice(0, 50);
  }

  private async recordTransaction(
    owner: SwichOwner,
    swichAccountId: bigint | null,
    customerTransactionId: string,
    channel: string,
    extra: { amount?: number; currency?: string; msisdn?: string; request_payload?: any } = {},
  ) {
    return this.prisma.swich_transactions.create({
      data: {
        workspace_id: owner.workspaceId ?? null,
        agency_id: owner.agencyId ?? null,
        swich_account_id: swichAccountId,
        customer_transaction_id: customerTransactionId,
        channel,
        amount: extra.amount ?? null,
        currency: extra.currency ?? 'PKR',
        msisdn: extra.msisdn ?? null,
        request_payload: extra.request_payload ?? undefined,
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  private async updateTransactionFromResponse(customerTransactionId: string, result: { data: any }) {
    const data = result.data ?? {};
    await this.prisma.swich_transactions.updateMany({
      where: { customer_transaction_id: customerTransactionId },
      data: {
        status: data.status ?? 'unknown',
        swich_transaction_id: data.transactionId != null ? String(data.transactionId) : undefined,
        swich_order_id: data.orderId ?? undefined,
        response_payload: data,
        updated_at: new Date(),
      },
    });
  }

  // ─── Section 5/6: Landing Page / PWA ──────────────────────────────────

  /** GET-style redirect URL — no API call, just checksum + query string. */
  async buildLandingPageUrl(
    owner: SwichOwner,
    params: {
      customerTransactionId?: string;
      item: string;
      // Agency Billing/Plans checkout only — matches billing_plans.item_id
      // (e.g. "ignite-plan"), so a successful payment can activate the real
      // plan for the agency. Absent for non-plan Swich payments.
      planItemId?: string;
      amount: number;
      description: string;
      payeeName: string;
      email: string;
      msisdn: string;
      billReferenceNo?: string;
      currency?: string;
      // Per the Swich PayIn 2.0 Integration Guide (Section 5.2 / Section 17):
      // this is the ONLY redirect parameter Swich's API accepts, and it only
      // ever fires on a SUCCESSFUL transaction. There is no failure/reject
      // redirect parameter — on a failed payment, Swich always sends the
      // customer to whatever default page is configured on the merchant's
      // own Swich dashboard (not something this API call can override).
      successRedirectUrl?: string;
    },
  ) {
    const account = await this.getAccount(owner);
    // Landing Page is the PWA flow (Section 5) — uses the PWA client_id, and
    // signs with checksum_secret if set, else the PWA client_secret (falls
    // back to the API client_secret only for accounts saved before PWA
    // credentials existed).
    const pwaClientId = account.pwa_client_id || account.client_id;
    const secret = account.checksum_secret || account.pwa_client_secret || account.client_secret;
    const customerTransactionId = params.customerTransactionId || this.generateCustomerTransactionId();
    const checksum = this.client.buildChecksum(secret, customerTransactionId, params.item, params.amount);

    await this.recordTransaction(owner, account.id, customerTransactionId, 'landing_page', {
      amount: params.amount,
      currency: params.currency,
      msisdn: params.msisdn,
      request_payload: params,
    });

    const url = this.client.buildLandingPageGetUrl(account.environment as SwichEnvironment, pwaClientId, {
      customerTransactionId,
      item: params.item,
      amount: params.amount,
      channel: 0,
      billReferenceNo: params.billReferenceNo,
      description: params.description,
      PayeeName: params.payeeName,
      Email: params.email,
      MSISDN: params.msisdn,
      currency: params.currency ?? 'PKR',
      checksum,
      successRedirectUrl: params.successRedirectUrl,
    });

    return { customerTransactionId, url };
  }

  // ─── Section 7-11 & 15: channel APIs ───────────────────────────────────
  //
  // Each method resolves credentials + token, stamps a customerTransactionId
  // + local transaction row, calls the matching SwichApiClient method, then
  // updates the row from the response. `body` is passed through mostly
  // verbatim — callers (controller) shape it per the doc's field list; we
  // only inject what must come from stored account state (nothing customer-
  // facing should ever need to know its own client_id).

  async purchaseEwallet(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'ewallet', body, (env, token, b) => this.client.purchaseEwallet(env, token, b));
  }

  async purchaseBiller(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'biller', body, (env, token, b) => this.client.purchaseBiller(env, token, b));
  }

  async getBanks(owner: SwichOwner) {
    const { account, token } = await this.resolve(owner);
    return this.client.getBanks(account.environment as SwichEnvironment, token);
  }

  async bankOtp(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'bank_otp', body, (env, token, b) => this.client.bankOtp(env, token, b));
  }

  async bankTransfer(owner: SwichOwner, body: any) {
    // Doesn't mint a new customerTransactionId — continues the one from bankOtp.
    const { account, token } = await this.resolve(owner);
    const result = await this.client.bankTransfer(account.environment as SwichEnvironment, token, body);
    if (body.customerTransactionId) await this.updateTransactionFromResponse(body.customerTransactionId, result);
    return result;
  }

  async qrGenerate(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'qr', body, (env, token, b) => this.client.qrGenerate(env, token, b));
  }

  async qrCancel(owner: SwichOwner, customerTransactionId: string) {
    const { account, token } = await this.resolve(owner);
    return this.client.qrCancel(account.environment as SwichEnvironment, token, customerTransactionId);
  }

  async qrInquire(owner: SwichOwner, customerTransactionId: string) {
    const { account, token } = await this.resolve(owner);
    return this.client.qrInquire(account.environment as SwichEnvironment, token, customerTransactionId);
  }

  async rtpTitle(owner: SwichOwner, query: Record<string, any>) {
    const { account, token } = await this.resolve(owner);
    return this.client.rtpTitle(account.environment as SwichEnvironment, token, query);
  }

  async rtpNowBankList(owner: SwichOwner) {
    const { account, token } = await this.resolve(owner);
    return this.client.rtpNowBankList(account.environment as SwichEnvironment, token);
  }

  async rtpNow(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'rtp_now', body, (env, token, b) => this.client.rtpNow(env, token, b), 'CustomerTransactionId');
  }

  async rtpLaterBankList(owner: SwichOwner) {
    const { account, token } = await this.resolve(owner);
    return this.client.rtpLaterBankList(account.environment as SwichEnvironment, token);
  }

  async rtpLater(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'rtp_later', body, (env, token, b) => this.client.rtpLater(env, token, b), 'CustomerTransactionId');
  }

  async rtpCancel(owner: SwichOwner, customerTransactionId: string) {
    const { account, token } = await this.resolve(owner);
    return this.client.rtpCancel(account.environment as SwichEnvironment, token, customerTransactionId);
  }

  async rtpInquire(owner: SwichOwner, customerTransactionId: string) {
    const { account, token } = await this.resolve(owner);
    return this.client.rtpInquire(account.environment as SwichEnvironment, token, customerTransactionId);
  }

  async inquire(owner: SwichOwner, customerTransactionId: string) {
    const { account, token } = await this.resolve(owner);
    const result = await this.client.inquire(account.environment as SwichEnvironment, token, customerTransactionId);
    // Inquire's response shape differs (nested `transaction` object) —
    // reuse the same updater, it only reads top-level status/ids which
    // Swich also mirrors at the top level for this endpoint's failure case.
    if (result?.data?.transaction) {
      const status = result.data.transaction.transactionStatus ?? result.data.status;
      await this.prisma.swich_transactions.updateMany({
        where: { customer_transaction_id: customerTransactionId },
        data: {
          status,
          response_payload: result.data,
          updated_at: new Date(),
        },
      });
      if (status === 'success') {
        const tx = await this.prisma.swich_transactions.findFirst({ where: { customer_transaction_id: customerTransactionId } });
        if (tx) await this.activatePlanFromTransaction(tx);
      }
    }
    return result;
  }

  async refund(owner: SwichOwner, body: { OrderId: string; Reason: string; Amount: number }) {
    const { account, token } = await this.resolve(owner);
    return this.client.refund(account.environment as SwichEnvironment, token, body);
  }

  async getRecurringInstrument(owner: SwichOwner, msisdn: string) {
    const { account, token } = await this.resolve(owner);
    return this.client.getRecurringInstrument(account.environment as SwichEnvironment, token, msisdn);
  }

  async initiateRecurringCardPayment(owner: SwichOwner, body: any) {
    return this.callChannel(owner, 'card_recurring', body, (env, token, b) => this.client.initiateRecurringCardPayment(env, token, b));
  }

  // ─── Section 16: Callback ──────────────────────────────────────────────

  /**
   * Verifies the checksum, updates our local transaction record, and always
   * returns {status:"success"} on a structurally valid, checksum-verified
   * callback so Swich doesn't retry-storm us — same "don't leak validation
   * detail to the caller, just don't act on it" shape as the webhook
   * receivers elsewhere in this codebase.
   */
  async handleCallback(payload: {
    PaymentType?: string;
    Status: string;
    OrderId: string;
    CustomerTransactionId: string;
    Amount: number;
    Checksum: string;
  }) {
    const tx = await this.prisma.swich_transactions.findFirst({
      where: { customer_transaction_id: payload.CustomerTransactionId },
    });
    if (!tx) {
      this.logger.warn(`Swich callback for unknown customerTransactionId=${payload.CustomerTransactionId}`);
      return { status: 'success' };
    }

    let secret: string | null | undefined;
    if (tx.swich_account_id != null) {
      const account = await this.prisma.swich_accounts.findUnique({ where: { id: tx.swich_account_id } });
      secret = account?.checksum_secret || account?.pwa_client_secret || account?.client_secret;
    } else {
      // Agency-scoped (env-based) transaction — no DB account row to look up.
      secret = process.env.SWICH_CHECKSUM_SECRET || process.env.SWICH_PWA_CLIENT_SECRET || process.env.SWICH_CLIENT_SECRET;
    }
    if (secret) {
      const expected = this.client.buildCallbackChecksum(
        secret,
        payload.CustomerTransactionId,
        payload.OrderId,
        payload.Amount,
        payload.Status,
      );
      const valid =
        expected.length === payload.Checksum?.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(payload.Checksum || ''));
      if (!valid) {
        this.logger.warn(`Swich callback checksum mismatch for ${payload.CustomerTransactionId} — ignoring status update`);
        return { status: 'success' };
      }
    }

    await this.prisma.swich_transactions.update({
      where: { id: tx.id },
      data: {
        status: payload.Status,
        swich_order_id: payload.OrderId,
        callback_payload: payload as any,
        updated_at: new Date(),
      },
    });

    if (payload.Status === 'success') {
      await this.activatePlanFromTransaction(tx);
    }

    return { status: 'success' };
  }

  /**
   * A successful Swich payment for an agency plan (checkout tags the request
   * with planItemId, matching billing_plans.item_id) activates that plan for
   * the agency — upserts billing_subscriptions directly, since Chargebee
   * (replyagent's source of truth for this table) isn't configured here.
   * No-op for workspace-scoped or non-plan agency payments.
   */
  private async activatePlanFromTransaction(tx: { agency_id: bigint | null; request_payload: any; customer_transaction_id: string }) {
    if (tx.agency_id == null) return;
    const planItemId = (tx.request_payload as any)?.planItemId;
    if (!planItemId) return;

    const plan = await this.prisma.billing_plans.findFirst({ where: { item_id: planItemId } });
    if (!plan) {
      this.logger.warn(`[swich] planItemId=${planItemId} not found in billing_plans — skipping subscription activation`);
      return;
    }

    const agency = await this.prisma.agencies.findUnique({ where: { id: tx.agency_id }, select: { customer_id: true } });

    const existing = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: tx.agency_id, status: { in: ['active', 'in_trial'] } },
      orderBy: [{ default: 'desc' }, { activated_at: 'desc' }],
    });

    let billingSubscriptionId: bigint;
    if (existing) {
      // No downgrades — plan_order ranks tiers (Free=0 ... Enterprise=3).
      // Matches the "plans don't support downgrades" notice on the Billing
      // page: a lower-tier payment still records as a transaction, it just
      // doesn't demote the active plan.
      if (existing.billing_plan_id) {
        const currentPlan = await this.prisma.billing_plans.findUnique({ where: { id: existing.billing_plan_id } });
        if (currentPlan && plan.plan_order < currentPlan.plan_order) {
          this.logger.warn(`[swich] agency ${tx.agency_id} paid for "${planItemId}" (order ${plan.plan_order}) below current plan "${currentPlan.item_id}" (order ${currentPlan.plan_order}) — not downgrading`);
          return;
        }
      }
      await this.prisma.billing_subscriptions.update({
        where: { id: existing.id },
        data: { billing_plan_id: plan.id, status: 'active', activated_at: new Date(), updated_at: new Date() },
      });
      billingSubscriptionId = existing.id;
    } else {
      const createdSubscription = await this.prisma.billing_subscriptions.create({
        data: {
          agency_id: tx.agency_id,
          subscription_id: `swich-${tx.customer_transaction_id}`,
          customer_id: agency?.customer_id || `swich-agency-${tx.agency_id}`,
          billing_plan_id: plan.id,
          default: true,
          status: 'active',
          activated_at: new Date(),
          started_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      billingSubscriptionId = createdSubscription.id;
    }

    await this.syncWorkspacesToPlan(tx.agency_id, plan);

    // Never let invoice generation block or fail plan activation — the plan
    // is already active at this point regardless of what happens below.
    this.invoices
      .generateInvoice({
        agencyId: tx.agency_id,
        billingSubscriptionId,
        planId: plan.id,
        planName: plan.external_name || plan.name,
        customerTransactionId: tx.customer_transaction_id,
      })
      .catch((err) => this.logger.error(`Invoice generation threw for agency ${tx.agency_id}: ${err?.message ?? err}`));

    this.logger.log(`[swich] activated plan "${planItemId}" for agency ${tx.agency_id}`);
  }

  // A plan upgrade only touches billing_subscriptions above — without this,
  // workspaces created under the OLD plan never see the new plan's higher
  // limits/features (e.g. White Label) until someone happens to re-save that
  // workspace's settings. Raises every existing workspace's plan-derived
  // fields up to the new plan's allowance; never lowers them, since a
  // downgrade already returns early above and can't reach this point.
  private async syncWorkspacesToPlan(agencyId: bigint, plan: { allow_branding: boolean; free_channels: number; free_agents: number; maximum_contacts: number; free_ai_agents: number }) {
    const workspaces = await this.prisma.workspaces.findMany({
      where: { agency_id: agencyId, deleted_at: null },
      select: {
        id: true,
        allow_branding: true,
        whatsapp_channels_limit: true,
        instagram_channels_limit: true,
        facebook_channels_limit: true,
        agents_limit: true,
        maximum_contacts: true,
        chatgpt_assistant_limit: true,
      },
    });

    for (const ws of workspaces) {
      await this.prisma.workspaces.update({
        where: { id: ws.id },
        data: {
          allow_branding: ws.allow_branding || plan.allow_branding,
          whatsapp_channels_limit: Math.max(ws.whatsapp_channels_limit, plan.free_channels),
          instagram_channels_limit: Math.max(ws.instagram_channels_limit, plan.free_channels),
          facebook_channels_limit: Math.max(ws.facebook_channels_limit, plan.free_channels),
          agents_limit: Math.max(ws.agents_limit, plan.free_agents),
          maximum_contacts: Math.max(ws.maximum_contacts, plan.maximum_contacts),
          chatgpt_assistant_limit: Math.max(ws.chatgpt_assistant_limit, plan.free_ai_agents),
        },
      });
    }
  }

  async getTransaction(owner: SwichOwner, customerTransactionId: string) {
    const tx = await this.prisma.swich_transactions.findFirst({
      where: { ...this.ownerWhere(owner) as any, customer_transaction_id: customerTransactionId },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }

  async listTransactions(owner: SwichOwner, limit = 50) {
    const where = owner.agencyId != null ? { agency_id: owner.agencyId } : { workspace_id: owner.workspaceId };
    const rows = await this.prisma.swich_transactions.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });
    // Swich's own Inquire/callback response (nested under `transaction`) is
    // the authoritative record of which channel + account actually paid —
    // prefer it over the msisdn we collected upfront at checkout, which is
    // only ever what the customer typed into our own form.
    return rows.map((row) => {
      const swichTx = (row.response_payload as any)?.transaction ?? (row.callback_payload as any)?.transaction;
      // `item` is whatever plan/product name the checkout page passed when it
      // built the Landing Page URL (see buildLandingPageUrl) — already stored
      // in request_payload, just not surfaced as its own field until now.
      const planName = (row.request_payload as any)?.item ?? null;
      return {
        ...row,
        plan_name: planName,
        swich_channel_name: swichTx?.channelName ?? null,
        swich_category_name: swichTx?.categoryName ?? null,
        swich_consumer_number: swichTx?.consumerNumber ?? null,
      };
    });
  }

  // ─── Shared helpers ────────────────────────────────────────────────────

  private async resolve(owner: SwichOwner) {
    const account = await this.getAccount(owner);
    const token = await this.getAccessToken(owner, account);
    return { account, token };
  }

  /** Generic "mint transaction id if missing, call, persist response" flow shared by most channels. */
  private async callChannel(
    owner: SwichOwner,
    channel: string,
    body: any,
    call: (env: SwichEnvironment, token: string, body: any) => Promise<{ data: any }>,
    idField: 'customerTransactionId' | 'CustomerTransactionId' = 'customerTransactionId',
  ) {
    const { account, token } = await this.resolve(owner);
    const customerTransactionId = body[idField] || this.generateCustomerTransactionId();
    const fullBody = { ...body, [idField]: customerTransactionId };

    await this.recordTransaction(owner, account.id, customerTransactionId, channel, {
      amount: fullBody.amount,
      currency: fullBody.currency,
      msisdn: fullBody.msisdn,
      request_payload: fullBody,
    });

    const result = await call(account.environment as SwichEnvironment, token, fullBody);
    await this.updateTransactionFromResponse(customerTransactionId, result);
    return result;
  }
}
