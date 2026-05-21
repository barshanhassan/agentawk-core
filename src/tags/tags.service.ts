// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
          display_inbox: 1,
        },
      });
    }

    return { success: true, tag };
  }

  /**
   * Link Tag to an entity
   */
  async linkTag(data: any) {
    const { tag_id, linkable_id, linkable_type } = data;
    if (!tag_id || !linkable_id || !linkable_type) {
      throw new BadRequestException(
        'tag_id, linkable_id, and linkable_type are required',
      );
    }

    const tag = await this.prisma.tags.findUnique({
      where: { id: BigInt(tag_id) },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    let existingLink = await this.prisma.tag_links.findFirst({
      where: {
        tag_id: BigInt(tag_id),
        linkable_id: BigInt(linkable_id),
        linkable_type: linkable_type,
      },
    });

    if (!existingLink) {
      existingLink = await this.prisma.tag_links.create({
        data: {
          tag_id: BigInt(tag_id),
          linkable_id: BigInt(linkable_id),
          linkable_type: linkable_type,
          name: tag.name,
        },
      });
    }

    return { success: true, tag_link: existingLink };
  }

  /**
   * Get Tag Links count for an entity
   */
  async getTagLinks(workspaceId: bigint, tagId: bigint) {
    const tag = await this.prisma.tags.findFirst({
      where: { id: tagId, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    const contactLinks = await this.prisma.tag_links.count({
      where: { tag_id: tagId, linkable_type: 'App\\Models\\Contact' },
    });
    const opportunityLinks = await this.prisma.tag_links.count({
      where: {
        tag_id: tagId,
        linkable_type: 'App\\Models\\Pipeline\\Opportunity',
      },
    });

    return {
      contacts: contactLinks,
      opportunity: opportunityLinks,
      automations: 0,
    };
  }

  /**
   * Unlink a tag
   */
  async unlinkTag(linkId: bigint) {
    const link = await this.prisma.tag_links.findUnique({
      where: { id: linkId },
    });
    if (!link) throw new NotFoundException('Link not found');

    await this.prisma.tag_links.delete({ where: { id: linkId } });
    return { success: true };
  }

  /**
   * Delete a tag
   */
  async deleteTag(workspaceId: bigint, tagId: bigint) {
    const tag = await this.prisma.tags.findFirst({
      where: { id: tagId, workspace_id: workspaceId },
    });
    if (!tag) throw new NotFoundException('Tag not found');

    await this.prisma.tag_links.deleteMany({ where: { tag_id: tagId } });
    await this.prisma.tags.delete({ where: { id: tagId } });

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

    const updated = await this.prisma.tags.update({ where: { id: tagId }, data: update });

    if (update.name) {
      await this.prisma.tag_links.updateMany({
        where: { tag_id: tagId },
        data: { name: update.name, updated_at: new Date() },
      });
    }
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
