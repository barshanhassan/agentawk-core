import { Injectable, NotFoundException, Logger } from '@nestjs/common';
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
