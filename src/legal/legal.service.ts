import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  // GET /legal — list active legal documents for the user's modelable (agency or workspace)
  async list(modelableType: string, modelableId: bigint) {
    const docs = await this.prisma.legal_documents.findMany({
      where: {
        modelable_type: modelableType,
        modelable_id: modelableId,
        status: 'ACTIVE',
        archived_at: null,
      },
      orderBy: { id: 'asc' },
    });
    return { documents: docs.map((d) => this.serialize(d)) };
  }

  // POST /legal — create a new legal document
  async create(modelableType: string, modelableId: bigint, userId: bigint, data: any) {
    const doc = await this.prisma.legal_documents.create({
      data: {
        modelable_type: modelableType,
        modelable_id: modelableId,
        name: data.name,
        link_text: data.link_text || data.name,
        label: data.label || '',
        type: data.type || 'CUSTOM',
        status: 'ACTIVE',
        file_url: data.file_url ?? null,
        file_media_id: data.file_media_id ? BigInt(data.file_media_id) : null,
        creator_id: userId,
        updater_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { document: this.serialize(doc) };
  }

  // PATCH /legal/:id — update document
  async update(documentId: bigint, userId: bigint, data: any) {
    const existing = await this.prisma.legal_documents.findUnique({ where: { id: documentId } });
    if (!existing) throw new NotFoundException('Legal document not found');

    const updated = await this.prisma.legal_documents.update({
      where: { id: documentId },
      data: {
        name: data.name ?? existing.name,
        link_text: data.link_text ?? existing.link_text,
        label: data.label ?? existing.label,
        type: data.type ?? existing.type,
        file_url: data.file_url ?? existing.file_url,
        file_media_id: data.file_media_id !== undefined
          ? (data.file_media_id ? BigInt(data.file_media_id) : null)
          : existing.file_media_id,
        updater_id: userId,
        updated_at: new Date(),
      },
    });
    return { document: this.serialize(updated) };
  }

  // DELETE /legal/:id — archive (soft delete)
  async archive(documentId: bigint, userId: bigint) {
    const existing = await this.prisma.legal_documents.findUnique({ where: { id: documentId } });
    if (!existing) throw new NotFoundException('Legal document not found');

    await this.prisma.legal_documents.update({
      where: { id: documentId },
      data: {
        status: 'ARCHIVED',
        archived_at: new Date(),
        updater_id: userId,
        updated_at: new Date(),
      },
    });
    return { success: true };
  }

  // GET /legal/accepted — documents the current user has accepted
  async getUserAccepted(userId: bigint) {
    const accepted = await this.prisma.user_accepted_terms.findMany({
      where: { user_id: userId },
    });
    if (accepted.length === 0) return { documents: [] };
    const docs = await this.prisma.legal_documents.findMany({
      where: { id: { in: accepted.map((a) => a.legal_document_id) } },
    });
    return { documents: docs.map((d) => this.serialize(d)) };
  }

  // GET /legal/agency_accepted — system documents the agency has accepted
  async getAgencyAccepted(agencyId: bigint) {
    const accepted = await this.prisma.agency_accepted_terms.findMany({
      where: { agency_id: agencyId },
    });
    return { accepted: accepted.map((a) => this.serialize(a)) };
  }

  // POST /accept-terms — user accepts a tenant legal document
  async acceptTerms(userId: bigint, documentId: bigint) {
    const doc = await this.prisma.legal_documents.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('Legal document not found');
    const existing = await this.prisma.user_accepted_terms.findFirst({
      where: { user_id: userId, legal_document_id: documentId },
    });
    if (existing) return { success: true, already: true };
    await this.prisma.user_accepted_terms.create({
      data: {
        user_id: userId,
        legal_document_id: documentId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { success: true };
  }

  // POST /accept-system-terms — agency accepts a platform-wide (system) document
  async acceptSystemTerms(agencyId: bigint, systemDocumentId: bigint) {
    const existing = await this.prisma.agency_accepted_terms.findFirst({
      where: { agency_id: agencyId, system_legal_document_id: systemDocumentId },
    });
    if (existing) return { success: true, already: true };
    await this.prisma.agency_accepted_terms.create({
      data: {
        agency_id: agencyId,
        system_legal_document_id: systemDocumentId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { success: true };
  }

  private serialize<T extends Record<string, any>>(obj: T): any {
    return JSON.parse(
      JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  }
}
