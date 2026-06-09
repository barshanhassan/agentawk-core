// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  async getCompanies(workspaceId: bigint, filters: any) {
    const page = parseInt(filters.page || '1');
    const limit = parseInt(filters.limit || '20');
    const where: any = { workspace_id: workspaceId, deleted_at: null };
    if (filters.search) where.name = { contains: filters.search };
    if (filters.status) where.status = filters.status;
    const [companies, total] = await Promise.all([
      this.prisma.companies.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.companies.count({ where }),
    ]);
    return { companies, total, page, limit };
  }

  async createNew(data: any, workspaceId: bigint, userId: bigint) {
    if (!data.name) throw new BadRequestException('Company name required');
    const existing = await this.prisma.companies.findFirst({
      where: { workspace_id: workspaceId, name: data.name, deleted_at: null },
    });
    if (existing) throw new BadRequestException('Company already exists');
    const company = await this.prisma.companies.create({
      data: {
        workspace_id: workspaceId,
        creator_id: userId,
        name: data.name,
        email: data.email || null,
        phone: data.phone || null,
        website: data.website || null,
        address: data.address || null,
        industry: data.industry || null,
        size: data.size || null,
        status: 'ACTIVE',
      },
    });
    return { success: true, company };
  }

  async getProfile(companyId: bigint, workspaceId: bigint) {
    const company = await this.prisma.companies.findFirst({
      where: { id: companyId, workspace_id: workspaceId },
    });
    if (!company) throw new NotFoundException('Company not found');
    const contacts = await this.prisma.contacts.findMany({
      where: { company_id: companyId, deleted_at: null },
      take: 50,
    });
    const deals = await this.prisma.pipeline_opportunity_contacts.findMany({
      where: { contact_id: { in: contacts.map((c) => c.id) } },
      take: 50,
    });
    return { company, contacts, deals };
  }

  async updateCompany(companyId: bigint, data: any, workspaceId: bigint) {
    const company = await this.prisma.companies.findFirst({
      where: { id: companyId, workspace_id: workspaceId },
    });
    if (!company) throw new NotFoundException('Company not found');
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.website !== undefined) updateData.website = data.website;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.industry !== undefined) updateData.industry = data.industry;
    if (data.size !== undefined) updateData.size = data.size;
    const updated = await this.prisma.companies.update({
      where: { id: companyId },
      data: updateData,
    });
    return { success: true, company: updated };
  }

  async assignCompany(companyId: bigint, data: any) {
    if (!data.contact_id) throw new BadRequestException('contact_id required');
    await this.prisma.contacts.update({
      where: { id: BigInt(data.contact_id) },
      data: { company_id: companyId },
    });
    return { success: true };
  }

  async deleteCompanyField(data: any) {
    if (!data.company_id || !data.field)
      throw new BadRequestException('company_id and field required');
    await this.prisma.companies.update({
      where: { id: BigInt(data.company_id) },
      data: { [data.field]: null },
    });
    return { success: true };
  }

  async changeStatus(data: any) {
    if (!data.company_id || !data.status)
      throw new BadRequestException('company_id and status required');
    await this.prisma.companies.update({
      where: { id: BigInt(data.company_id) },
      data: { status: data.status },
    });
    return { success: true };
  }

  async deleteCompany(companyId: bigint, workspaceId: bigint) {
    const company = await this.prisma.companies.findFirst({
      where: { id: companyId, workspace_id: workspaceId },
    });
    if (!company) throw new NotFoundException('Company not found');
    await this.prisma.contacts.updateMany({
      where: { company_id: companyId },
      data: { company_id: null },
    });
    await this.prisma.companies.update({
      where: { id: companyId },
      data: { deleted_at: new Date() },
    });
    return { success: true };
  }

  async switchCompany(data: any) {
    if (!data.contact_id || !data.company_id)
      throw new BadRequestException('contact_id and company_id required');
    await this.prisma.contacts.update({
      where: { id: BigInt(data.contact_id) },
      data: { company_id: BigInt(data.company_id) },
    });
    return { success: true };
  }

  async assignedAgent(data: any, workspaceId: bigint) {
    if (!data.company_id) throw new BadRequestException('company_id required');
    const contacts = await this.prisma.contacts.findMany({
      where: {
        company_id: BigInt(data.company_id),
        workspace_id: workspaceId,
        deleted_at: null,
      },
    });
    return { contacts };
  }
}
