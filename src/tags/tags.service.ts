// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

// Replyagent stores `taggable_type` with the Laravel namespace path so existing
// log readers / cross-workspace tooling can identify the entity class without
// translation. We mirror those exact strings here.
const TAGGABLE_TYPES = {
  WORKSPACE: 'App\\Models\\Workspace',
  CONTACT: 'App\\Models\\Contact',
  COMPANY: 'App\\Models\\Company',
  OPPORTUNITY: 'App\\Models\\Pipeline\\Opportunity',
} as const;

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * audit_logs row writer for tag CRUD/link events. Best-effort — a failure
   * here must never block the user-visible mutation.
   */
  private async audit(
    workspaceId: bigint,
    userId: bigint | null,
    event: string,
    tagId: bigint | null,
    data: any,
  ): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event,
          modelable_type: 'App\\Models\\Tag\\Tag',
          modelable_id: tagId,
          data: JSON.stringify(data ?? {}),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[tags] audit log write failed (event=${event}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Get tags for an object
   */
  async getTags(taggableType: string, taggableId: bigint) {
    return this.prisma.tags.findMany({
      where: {
        taggable_type: taggableType,
        taggable_id: taggableId,
      },
    });
  }

  /**
   * Get paginated tag list for a workspace
   */
  async getTagList(workspaceId: bigint, filters: any) {
    const page = parseInt(filters.page || '1');
    const limit = parseInt(filters.limit || '50');
    const skip = (page - 1) * limit;

    const where: any = { workspace_id: workspaceId };

    if (filters.for) {
      switch (filters.for) {
        case 'OPPORTUNITY':
          where.taggable_type = 'App\\Models\\Pipeline\\Opportunity';
          break;
        case 'COMPANY':
          where.taggable_type = 'App\\Models\\Company';
          break;
        case 'WORKSPACE':
          where.taggable_type = 'App\\Models\\Workspace';
          break;
        case 'CONTACT':
          where.taggable_type = 'App\\Models\\Contact';
          break;
      }
    }

    const folder_id = filters.folder_id;
    if (folder_id === undefined || folder_id === null) {
      where.folder_id = null;
    } else if (folder_id !== 'ALL') {
      where.folder_id = BigInt(folder_id);
    }

    if (filters.search) {
      where.name = { contains: filters.search };
    }

    const [tags, total] = await Promise.all([
      this.prisma.tags.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.tags.count({ where }),
    ]);

    return { tags, total, page, limit };
  }

  /**
   * Get tag data including folders
   */
  async getTagData(workspaceId: bigint, filters: any) {
    const where: any = { workspace_id: workspaceId };

    const folder_id = filters.folder_id;
    if (folder_id === 'root') {
      where.folder_id = null;
    } else if (folder_id && folder_id !== 'ALL') {
      where.folder_id = BigInt(folder_id);
    }

    const [tags, folders] = await Promise.all([
      this.prisma.tags.findMany({ where }),
      this.prisma.tag_folders.findMany({
        where: { workspace_id: workspaceId },
      }),
    ]);

    return { success: true, folders, tags };
  }

  /**
   * Create or Update a Tag
   */
  async createTag(workspaceId: bigint, userId: bigint, data: any) {
    if (!data.name) throw new BadRequestException('Tag name required');
    const name = data.name.replace(/\s+/g, '');

    let tag;
    if (data.id) {
      tag = await this.prisma.tags.findFirst({
        where: { id: BigInt(data.id), workspace_id: workspaceId },
      });
      if (!tag) throw new NotFoundException('Tag not found');

      tag = await this.prisma.tags.update({
        where: { id: tag.id },
        data: {
          name,
          folder_id: data.folder_id ? BigInt(data.folder_id) : null,
          text_color: data.text_color || tag.text_color,
          bg_color: data.bg_color || tag.bg_color,
          display_inbox:
            data.display_inbox !== undefined
              ? data.display_inbox
                ? 1
                : 0
              : tag.display_inbox,
        },
      });
    } else {
      const taggableType = data.taggable_type || 'App\\Models\\Workspace';
      const taggableId = data.taggable_id
        ? BigInt(data.taggable_id)
        : workspaceId;

      const existing = await this.prisma.tags.findFirst({
        where: {
          workspace_id: workspaceId,
          name,
          taggable_type: taggableType,
          taggable_id: taggableId,
        },
      });

      if (existing) throw new BadRequestException('Tag name already exists');

      tag = await this.prisma.tags.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          name,
          folder_id: data.folder_id ? BigInt(data.folder_id) : null,
          taggable_type: taggableType,
          taggable_id: taggableId,
          text_color: data.text_color || '#111827',
          bg_color: data.bg_color || '#f3f4f6',
          display_inbox:
            data.display_inbox === undefined ? 1 : data.display_inbox ? 1 : 0,
        },
      });
    }

    // Fire automation triggers + cross-module listeners. `tag.updated` covers
    // both the update + the rename case (downstream filters can branch on the
    // payload).
    this.events.emit(data.id ? 'tag.updated' : 'tag.created', {
      tagId: tag.id,
      workspaceId,
      userId,
      name: tag.name,
    });
    await this.audit(
      workspaceId,
      userId,
      data.id ? 'tag_updated' : 'tag_created',
      tag.id,
      { name: tag.name, folder_id: tag.folder_id?.toString() ?? null },
    );

    return { success: true, tag };
  }

  /**
   * Link a tag to an entity. Workspace isolation enforced — the caller's
   * workspace MUST own the tag, else `linkable_id` could be tagged with a
   * tag from another tenant just by knowing the tag's primary key.
   * Mirrors replyagent's `TagsController@linkTag` semantics.
   */
  async linkTag(workspaceId: bigint, userId: bigint | null, data: any) {
    const { tag_id, linkable_id, linkable_type } = data;
    if (!tag_id || !linkable_id || !linkable_type) {
      throw new BadRequestException(
        'tag_id, linkable_id, and linkable_type are required',
      );
    }

    const tag = await this.prisma.tags.findFirst({
      where: { id: BigInt(tag_id), workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    let existingLink = await this.prisma.tag_links.findFirst({
      where: {
        tag_id: BigInt(tag_id),
        linkable_id: BigInt(linkable_id),
        linkable_type: linkable_type,
      },
    });

    let created = false;
    if (!existingLink) {
      existingLink = await this.prisma.tag_links.create({
        data: {
          tag_id: BigInt(tag_id),
          linkable_id: BigInt(linkable_id),
          linkable_type: linkable_type,
          name: tag.name,
        },
      });
      created = true;
    }

    if (created) {
      // `contact.tag_applied` is the contact-side mirror that automations
      // already listen for ([[automation-trigger.service.ts:40]]); `tag.applied`
      // is the entity-agnostic dispatch.
      this.events.emit('tag.applied', {
        tagId: tag.id,
        workspaceId,
        linkableType: linkable_type,
        linkableId: BigInt(linkable_id),
      });
      if (linkable_type === TAGGABLE_TYPES.CONTACT) {
        this.events.emit('contact.tag_applied', {
          contactId: BigInt(linkable_id),
          tagId: tag.id,
          workspaceId,
        });
      }
      await this.audit(workspaceId, userId, 'tag_applied', tag.id, {
        linkable_type,
        linkable_id: String(linkable_id),
      });
    }

    return { success: true, tag_link: existingLink };
  }

  /**
   * Return per-entity usage counts for a tag. Mirrors replyagent's
   * `getTagLinks`. Automation usage is counted by looking for automation
   * steps that reference the tag id in their config JSON — both the
   * `apply_tag` / `remove_tag` actions and `tag_added` / `tag_removed`
   * triggers persist the tag id inside the activity's JSON payload.
   */
  async getTagLinks(workspaceId: bigint, tagId: bigint) {
    const tag = await this.prisma.tags.findFirst({
      where: { id: tagId, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    const [contactLinks, opportunityLinks, automationCount] = await Promise.all(
      [
        this.prisma.tag_links.count({
          where: { tag_id: tagId, linkable_type: TAGGABLE_TYPES.CONTACT },
        }),
        this.prisma.tag_links.count({
          where: { tag_id: tagId, linkable_type: TAGGABLE_TYPES.OPPORTUNITY },
        }),
        this.countAutomationUsage(workspaceId, tagId),
      ],
    );

    return {
      contacts: contactLinks,
      opportunity: opportunityLinks,
      automations: automationCount,
    };
  }

  /**
   * Best-effort scan for automation steps that mention this tag id. Falls
   * back to 0 if the `automation_steps` model isn't queryable in this
   * deployment (raw query keeps it resilient to schema renames).
   */
  private async countAutomationUsage(
    workspaceId: bigint,
    tagId: bigint,
  ): Promise<number> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT COUNT(DISTINCT s.id) AS c
           FROM automation_steps s
           JOIN automations a ON a.id = s.automation_id
          WHERE a.workspace_id = ?
            AND (
              s.comment LIKE ?
              OR EXISTS (
                SELECT 1 FROM automation_step_activities act
                 WHERE act.step_id = s.id
                   AND act.payload LIKE ?
              )
            )`,
        workspaceId,
        `%"tag_id":${tagId}%`,
        `%"tag_id":${tagId}%`,
      );
      return Number(rows?.[0]?.c ?? 0);
    } catch (err: any) {
      this.logger.debug(
        `[tags.countAutomationUsage] fallback to 0 — ${err?.message ?? err}`,
      );
      return 0;
    }
  }

  /**
   * Unlink a tag. Emits `tag.removed` so automations that listen for tag
   * removal can fire. Audit logged as `tag_removed`.
   */
  async unlinkTag(workspaceId: bigint, userId: bigint | null, linkId: bigint) {
    const link = await this.prisma.tag_links.findUnique({
      where: { id: linkId },
    });
    if (!link) throw new NotFoundException('Link not found');

    // Workspace isolation — make sure the link's tag is owned by the
    // caller's workspace before deleting.
    const tag = await this.prisma.tags.findFirst({
      where: { id: link.tag_id, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    await this.prisma.tag_links.delete({ where: { id: linkId } });

    this.events.emit('tag.removed', {
      tagId: tag.id,
      workspaceId,
      linkableType: link.linkable_type,
      linkableId: link.linkable_id,
    });
    if (link.linkable_type === TAGGABLE_TYPES.CONTACT) {
      this.events.emit('contact.tag_removed', {
        contactId: link.linkable_id,
        tagId: tag.id,
        workspaceId,
      });
    }
    await this.audit(workspaceId, userId, 'tag_removed', tag.id, {
      linkable_type: link.linkable_type,
      linkable_id: String(link.linkable_id),
    });
    return { success: true };
  }

  /**
   * Delete a tag. Cascades to tag_links (replyagent's `removeLinks()`).
   * Emits `tag.deleted` for automations + cache invalidation.
   */
  async deleteTag(
    workspaceId: bigint,
    userId: bigint | null,
    tagId: bigint,
  ) {
    const tag = await this.prisma.tags.findFirst({
      where: { id: tagId, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    await this.prisma.tag_links.deleteMany({ where: { tag_id: tagId } });
    await this.prisma.tags.delete({ where: { id: tagId } });

    this.events.emit('tag.deleted', {
      tagId,
      workspaceId,
      name: tag.name,
    });
    await this.audit(workspaceId, userId, 'tag_deleted', tagId, {
      name: tag.name,
    });

    return { success: true };
  }

  /**
   * Update a tag's name/status. Also propagates the new name to all tag_links
   * rows so denormalized "name" stays in sync (mirrors gateway behavior).
   */
  async updateTag(workspaceId: bigint, tagId: bigint, data: any) {
    const tag = await this.prisma.tags.findFirst({
      where: { id: tagId, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    const update: any = { updated_at: new Date() };
    if (data.name !== undefined && data.name !== tag.name) {
      update.name = data.name;
    }
    if (data.display_inbox !== undefined) {
      update.display_inbox = data.display_inbox ? 1 : 0;
    }
    if (data.folder_id !== undefined) {
      update.folder_id = data.folder_id ? BigInt(data.folder_id) : null;
    }

    // Accept color updates here too so the edit modal can change them
    // without going through createTag (replyagent allows both shapes).
    if (data.text_color !== undefined) update.text_color = data.text_color;
    if (data.bg_color !== undefined) update.bg_color = data.bg_color;

    const updated = await this.prisma.tags.update({ where: { id: tagId }, data: update });

    if (update.name) {
      await this.prisma.tag_links.updateMany({
        where: { tag_id: tagId },
        data: { name: update.name, updated_at: new Date() },
      });
    }

    this.events.emit('tag.updated', {
      tagId,
      workspaceId,
      name: updated.name,
    });
    await this.audit(workspaceId, null, 'tag_updated', tagId, {
      name: updated.name,
      bg_color: updated.bg_color,
      text_color: updated.text_color,
      display_inbox: updated.display_inbox,
    });
    return { success: true, tag: updated };
  }

  // ─── Folder Management ──────────────────────────────────────────────

  async getFolders(workspaceId: bigint) {
    return this.prisma.tag_folders.findMany({
      where: { workspace_id: workspaceId },
    });
  }

  async createFolder(workspaceId: bigint, data: any) {
    if (data.id) {
      const folder = await this.prisma.tag_folders.findFirst({
        where: { id: BigInt(data.id), workspace_id: workspaceId },
      });
      if (!folder) throw new NotFoundException('Folder not found');

      return this.prisma.tag_folders.update({
        where: { id: folder.id },
        data: { name: data.name },
      });
    }

    return this.prisma.tag_folders.create({
      data: {
        workspace_id: workspaceId,
        name: data.name,
      },
    });
  }

  async changeFolder(
    workspaceId: bigint,
    tagId: bigint,
    folderId: bigint | null,
  ) {
    const tag = await this.prisma.tags.findFirst({
      where: { id: tagId, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    if (folderId) {
      const folder = await this.prisma.tag_folders.findFirst({
        where: { id: folderId, workspace_id: workspaceId },
      });
      if (!folder) throw new NotFoundException('Folder not found');
    }

    return this.prisma.tags.update({
      where: { id: tagId },
      data: { folder_id: folderId },
    });
  }

  async deleteFolder(workspaceId: bigint, folderId: bigint) {
    const folder = await this.prisma.tag_folders.findFirst({
      where: { id: folderId, workspace_id: workspaceId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const hasTags = await this.prisma.tags.count({
      where: { folder_id: folderId },
    });
    if (hasTags > 0) throw new BadRequestException('Folder is not empty');

    await this.prisma.tag_folders.delete({
      where: { id: folderId },
    });

    return { success: true };
  }
}
