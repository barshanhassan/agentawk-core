import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
  ) {}

  /**
   * Pull all message templates from Meta for the workspace's WABA(s) and upsert
   * into wa_templates. Status (APPROVED/PENDING/REJECTED) plus components and
   * language reflect Meta's authoritative state. Call after onboarding and on
   * admin-triggered "sync" button.
   */
  async syncTemplatesFromMeta(workspaceId: bigint) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (accounts.length === 0) throw new NotFoundException('No WABA accounts found for workspace');

    let totalSynced = 0;
    for (const acc of accounts) {
      const remote = await this.meta.fetchTemplates(acc.waba_id, acc.access_token);
      for (const t of remote) {
        const existing = await this.prisma.wa_templates.findFirst({
          where: { wa_account_id: acc.id.toString(), template_id: t.id ?? t.name },
        });
        const data: any = {
          wa_account_id: acc.id.toString(),
          template_id: t.id ?? t.name,
          name: t.name,
          category: t.category ?? 'UTILITY',
          status: t.status ?? 'PENDING',
          language: t.language ?? 'en',
          components: t.components ? JSON.stringify(t.components) : null,
          template: JSON.stringify(t),
          last_updated: new Date(),
          updated_at: new Date(),
        };
        if (existing) {
          await this.prisma.wa_templates.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.wa_templates.create({
            data: { ...data, created_at: new Date() },
          });
        }
        totalSynced++;
      }
    }
    this.logger.log(`syncTemplatesFromMeta: synced ${totalSynced} templates for workspace ${workspaceId}`);
    return { success: true, synced: totalSynced };
  }

  /**
   * Create a WhatsApp message template. Builds Meta's `components` payload from
   * the form fields, submits it to the Graph API (template enters PENDING
   * review), and persists a local wa_templates row so it shows in the list.
   */
  async createTemplate(workspaceId: bigint, dto: any) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (accounts.length === 0) throw new NotFoundException('No WhatsApp account connected for this workspace');

    const account =
      (dto?.wa_account_id != null
        ? accounts.find((a) => a.id.toString() === String(dto.wa_account_id))
        : undefined) ?? accounts[0];

    // ── normalise name / category / language ─────────────────────────────
    const name = String(dto?.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!name) throw new BadRequestException('Template name is required');

    const body = String(dto?.body ?? '').trim();
    if (!body) throw new BadRequestException('Template body is required');

    const categoryMap: Record<string, string> = {
      marketing: 'MARKETING',
      utility: 'UTILITY',
      authentication: 'AUTHENTICATION',
    };
    const category = categoryMap[String(dto?.category ?? '').toLowerCase()] ?? String(dto?.category ?? 'UTILITY').toUpperCase();

    const langMap: Record<string, string> = {
      english: 'en_US',
      en: 'en',
      urdu: 'ur',
      arabic: 'ar',
      spanish: 'es',
    };
    const language = langMap[String(dto?.language ?? '').toLowerCase()] ?? String(dto?.language ?? 'en_US');

    const samples: Record<string, string> = dto?.examples ?? dto?.variableSamples ?? {};
    const varsOf = (text: string): string[] => {
      const m = String(text ?? '').match(/\{\{([^}]+)\}\}/g) ?? [];
      const seen: string[] = [];
      for (const raw of m) {
        const key = raw.replace(/^\{\{|\}\}$/g, '').trim();
        if (!seen.includes(key)) seen.push(key);
      }
      return seen;
    };

    // ── build Meta components ────────────────────────────────────────────
    const components: any[] = [];

    const headerText = String(dto?.header ?? dto?.headerText ?? '').trim();
    const mediaSelected = dto?.mediaSample && dto.mediaSample !== 'none';
    if (mediaSelected) {
      // Media headers need a resumable-upload handle — not supported yet.
      throw new BadRequestException(
        'Media header templates are not supported yet. Use a text header or no header.',
      );
    }
    if (headerText) {
      const header: any = { type: 'HEADER', format: 'TEXT', text: headerText };
      const hv = varsOf(headerText);
      if (hv.length) header.example = { header_text: hv.map((v) => samples[v] || v) };
      components.push(header);
    }

    const bodyComp: any = { type: 'BODY', text: body };
    const bv = varsOf(body);
    if (bv.length) bodyComp.example = { body_text: [bv.map((v) => samples[v] || v)] };
    components.push(bodyComp);

    const footerText = String(dto?.footer ?? dto?.footerText ?? '').trim();
    if (footerText) components.push({ type: 'FOOTER', text: footerText });

    const buttons = Array.isArray(dto?.buttons)
      ? dto.buttons.map((b: any) => this.mapTemplateButton(b)).filter(Boolean)
      : [];
    if (buttons.length) components.push({ type: 'BUTTONS', buttons });

    const payload = { name, language, category, components };

    // ── submit to Meta + persist ─────────────────────────────────────────
    const res = await this.meta.createTemplate(account.waba_id, account.access_token, payload);

    const now = new Date();
    const row = await this.prisma.wa_templates.create({
      data: {
        wa_account_id: account.id.toString(),
        template_id: res?.id ?? name,
        name,
        category: (res?.category ?? category) as string,
        status: (res?.status ?? 'PENDING') as string,
        language,
        components: JSON.stringify(components),
        template: JSON.stringify({ ...payload, id: res?.id, status: res?.status }),
        last_updated: now,
        created_at: now,
        updated_at: now,
      },
    });
    this.logger.log(`createTemplate: "${name}" (${category}/${language}) → Meta id ${res?.id ?? 'n/a'} status ${res?.status ?? 'PENDING'}`);
    return row;
  }

  /** Map a frontend button object to Meta's template button schema. */
  private mapTemplateButton(b: any): any | null {
    const text = String(b?.buttonText ?? b?.text ?? '').trim();
    switch (b?.type) {
      case 'quick-reply':
        return text ? { type: 'QUICK_REPLY', text } : null;
      case 'visit-website':
        return text && b?.websiteUrl ? { type: 'URL', text, url: String(b.websiteUrl).trim() } : null;
      case 'call-phone':
        return text && b?.phoneNumber
          ? { type: 'PHONE_NUMBER', text, phone_number: `${b?.country ?? ''}${b.phoneNumber}`.trim() }
          : null;
      case 'copy-offer':
        return b?.offerCode ? { type: 'COPY_CODE', example: String(b.offerCode).trim() } : null;
      default:
        return null;
    }
  }

  async getTemplates(workspaceId: bigint) {
    // Find WABA accounts for this workspace
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId },
    });

    if (accounts.length === 0) return [];

    const accountIds = accounts.map((a) => a.id.toString());

    // Fetch templates for these accounts
    const templates = await this.prisma.wa_templates.findMany({
      where: {
        wa_account_id: { in: accountIds },
      },
      orderBy: { created_at: 'desc' },
    });

    return templates;
  }

  async getTemplate(id: bigint, workspaceId: bigint) {
    // Verification that template belongs to workspace
    const template = await this.prisma.wa_templates.findUnique({
      where: { id },
    });

    if (!template) throw new NotFoundException('Template not found');

    const account = await this.prisma.wa_accounts.findFirst({
      where: {
        id: BigInt(template.wa_account_id),
        workspace_id: workspaceId,
      },
    });

    if (!account)
      throw new NotFoundException('Template does not belong to your workspace');

    return template;
  }

  async deleteTemplate(id: bigint, workspaceId: bigint) {
    const template = await this.getTemplate(id, workspaceId);
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: BigInt(template.wa_account_id), workspace_id: workspaceId },
    });

    if (account) {
      try {
        await this.meta.deleteTemplate(account.waba_id, account.access_token, template.name);
      } catch (e: any) {
        // Don't block local cleanup if Meta returns 404 — already gone there.
        this.logger.warn(`Meta deleteTemplate failed for ${template.name}: ${e?.message ?? e}`);
      }
    }

    await this.prisma.wa_templates.delete({ where: { id: template.id } });
    return { success: true };
  }

  async getTemplateStatistics(workspaceId: bigint) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId },
    });

    if (accounts.length === 0) {
      return {
        total: 0,
        approved: 0,
        pending: 0,
        delivered: 0,
        readRate: '0%',
        cost: '$0.00'
      };
    }

    const accountIds = accounts.map((a) => a.id.toString());

    const [total, approved, pending] = await Promise.all([
      this.prisma.wa_templates.count({
        where: { wa_account_id: { in: accountIds } }
      }),
      this.prisma.wa_templates.count({
        where: { wa_account_id: { in: accountIds }, status: 'APPROVED' }
      }),
      this.prisma.wa_templates.count({
        where: { wa_account_id: { in: accountIds }, status: 'PENDING' }
      })
    ]);

    // For delivered, readRate, and cost, we might need a different table like wa_messages or wa_logs
    // For now, I'll return some realistic counts from the templates themselves if available, 
    // or keep them as placeholders if the schema doesn't support them yet.
    
    return {
      total,
      approved,
      pending,
      delivered: 0, // TODO: Implement when messaging stats are available
      readRate: '0%',
      cost: '$0.00'
    };
  }
}
