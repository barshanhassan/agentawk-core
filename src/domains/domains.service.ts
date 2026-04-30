// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntriService } from '../libraries/entri.service';

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entri: EntriService,
  ) {}

  // ─── Domain Management ─────────────────────────────────────────────

  async addCustomDomain(
    workspaceId: bigint,
    siteType: string,
    subDomain: string,
    rootDomain: string,
    userId: bigint,
  ) {
    const sub_domain = subDomain.toLowerCase();
    const root_domain = rootDomain.toLowerCase().replace(/^\//, '');
    const protocol =
      process.env.NODE_ENV === 'production' ? 'https://' : 'http://';
    const full_domain = `${protocol}${sub_domain}.${root_domain}`;

    // Reserved domains check (logic from Laravel)
    const reserved = [
      'https://app.leadagent.io',
      'https://test.leadagent.io',
      'https://api.leadagent.io',
    ];
    if (reserved.includes(full_domain)) {
      throw new BadRequestException('Domain is taken');
    }

    // Check if exists
    const existing = await this.prisma.domains.findUnique({
      where: { domain: full_domain },
    });
    if (existing) throw new BadRequestException('Domain is taken');

    const modelable_type =
      siteType === 'WORKSPACE'
        ? 'App\\Models\\Workspace'
        : 'App\\Models\\Agency';

    // Add domain
    const domain = await this.prisma.domains.create({
      data: {
        modelable_id: workspaceId,
        modelable_type: modelable_type,
        sub_domain: sub_domain,
        root_domain: root_domain,
        domain: full_domain,
        is_default: false,
        active: false,
      },
    });

    // Activate it
    await this.activateDomain(domain.id, workspaceId, modelable_type);

    // Audit Log (if workspace)
    if (siteType === 'WORKSPACE') {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          event: 'domain_added',
          user_id: userId,
          modelable_id: domain.id,
          modelable_type: 'App\\Models\\Domain',
          data: JSON.stringify({ domain: domain.domain }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    const domains = await this.prisma.domains.findMany({
      where: { modelable_id: workspaceId, modelable_type: modelable_type },
    });

    return {
      message: 'Domain successfully updated',
      domains: domains,
    };
  }

  async validateDomain(subDomain: string, rootDomain: string) {
    const sub_domain = subDomain.toLowerCase();
    const root_domain = rootDomain.toLowerCase();

    const exist = await this.prisma.domains.findFirst({
      where: { sub_domain, root_domain },
    });

    return { available: !exist };
  }

  async deleteCustomDomain(workspaceId: bigint, siteType: string) {
    const modelable_type =
      siteType === 'WORKSPACE'
        ? 'App\\Models\\Workspace'
        : 'App\\Models\\Agency';

    const domain = await this.prisma.domains.findFirst({
      where: {
        modelable_id: workspaceId,
        modelable_type: modelable_type,
        active: true,
        is_default: false,
      },
    });

    if (!domain) throw new NotFoundException('Invalid domain');

    // Delete from Entri (matches Domain::deleteIt() in gateway)
    try {
      await this.entri.deletePowerDomain(
        `${domain.sub_domain}.${domain.root_domain}`,
      );
    } catch (err) {
      this.logger.warn(
        `Entri delete failed (continuing local cleanup): ${err.message}`,
      );
    }

    await this.prisma.$transaction([
      // Activate default domain
      this.prisma.domains.updateMany({
        where: {
          modelable_id: workspaceId,
          modelable_type: modelable_type,
          is_default: true,
        },
        data: { active: true },
      }),
      // Delete this domain
      this.prisma.domains.delete({ where: { id: domain.id } }),
    ]);

    const domains = await this.prisma.domains.findMany({
      where: { modelable_id: workspaceId, modelable_type: modelable_type },
    });

    return {
      message: 'Domain successfully deleted',
      domains: domains,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async activateDomain(
    domainId: bigint,
    modelableId: bigint,
    modelableType: string,
  ) {
    await this.prisma.$transaction([
      this.prisma.domains.updateMany({
        where: {
          modelable_id: modelableId,
          modelable_type: modelableType,
          active: true,
        },
        data: { active: false },
      }),
      this.prisma.domains.update({
        where: { id: domainId },
        data: { active: true },
      }),
    ]);
  }

  async getEntriToken() {
    const token = await this.entri.getToken();
    if (!token) {
      throw new BadRequestException('Failed to retrieve Entri token');
    }
    return { token };
  }
}
