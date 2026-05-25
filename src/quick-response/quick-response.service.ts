// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QuickResponseService {
  private readonly logger = new Logger(QuickResponseService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or Update a Quick Response Message
   */
  async createMessage(workspaceId: bigint, userId: bigint, data: any) {
    const { title, group_id, id, type, text, media_list } = data;

    if (!title || !group_id) {
      throw new BadRequestException('Title and group_id are required');
    }

    const group = await this.prisma.quick_responses.findUnique({
      where: { id: BigInt(group_id) },
    });

    if (!group) {
      throw new BadRequestException('Invalid group');
    }

    let message;
    if (id) {
      message = await this.prisma.quick_responses.findFirst({
        where: { id: BigInt(id), workspace_id: workspaceId },
      });
      if (!message) throw new NotFoundException('Message not found');

      message = await this.prisma.quick_responses.update({
        where: { id: message.id },
        data: {
          title,
          text: text || null,
          type: type || 'text',
        },
      });
    } else {
      // Check limit
      const count = await this.prisma.quick_responses.count({
        where: { user_id: userId, parent_id: group.id },
      });
      // Assuming a limit of 50 as per Laravel code implicit check
      if (count > 50) {
        throw new BadRequestException(
          'Quick response limit reached for this group',
        );
      }

      message = await this.prisma.quick_responses.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          parent_id: group.id,
          share: group.share,
          title,
          text: text || null,
          type: type || 'text',
        },
      });
    }

    // Handle Media List
    if (media_list && Array.isArray(media_list)) {
      await this.prisma.quick_response_media.deleteMany({
        where: { quick_response_id: message.id },
      });

      for (const media of media_list) {
        await this.prisma.quick_response_media.create({
          data: {
            quick_response_id: message.id,
            gallery_media_id: BigInt(media.id),
          },
        });
      }
    }

    return {
      success: true,
      qr: await this.prisma.quick_responses.findUnique({
        where: { id: message.id },
      }),
      group,
    };
  }

  /**
   * Create or Update a Category Group
   */
  async createGroup(workspaceId: bigint, userId: bigint, data: any) {
    const { title, id, share, bindings } = data;

    if (!title) throw new BadRequestException('Title is required');

    if (id) {
      const group = await this.prisma.quick_responses.findFirst({
        where: { id: BigInt(id), workspace_id: workspaceId },
      });
      if (!group) throw new NotFoundException('Group not found');

      return this.prisma.quick_responses.update({
        where: { id: group.id },
        data: {
          title,
          share: share || 'private',
          bindings: bindings ? JSON.stringify(bindings) : null,
        },
      });
    }

    return this.prisma.quick_responses.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        title,
        share: share || 'private',
        bindings: bindings ? JSON.stringify(bindings) : null,
      },
    });
  }

  /**
   * Get responses and folders visible to the user
   */
  async getResponse(workspaceId: bigint, userId: bigint) {
    // Fetch all responses visible to user
    const responses = await this.prisma.quick_responses.findMany({
      where: {
        workspace_id: workspaceId,
        OR: [
          { user_id: userId },
          { share: 'public' },
          {
            AND: [
              { bindings: { not: null } },
              { bindings: { contains: userId.toString() } },
            ],
          },
        ],
      },
      orderBy: { id: 'asc' },
    });

    const folders = await this.prisma.quick_responses.findMany({
      where: {
        workspace_id: workspaceId,
        parent_id: null,
        OR: [
          { user_id: userId },
          { share: 'public' },
          {
            AND: [
              { bindings: { not: null } },
              { bindings: { contains: userId.toString() } },
            ],
          },
        ],
      },
      orderBy: { id: 'asc' },
    });

    return { responses, folders };
  }

  /**
   * Delete a Response or Group
   */
  async deleteResponse(workspaceId: bigint, userId: bigint, id: bigint) {
    const qr = await this.prisma.quick_responses.findUnique({
      where: { id },
    });

    if (!qr) throw new NotFoundException('Quick response not found');
    if (qr.user_id !== userId) throw new BadRequestException('Not authorized');

    if (qr.parent_id === null) {
      // It's a group, delete children
      await this.prisma.quick_responses.deleteMany({
        where: { parent_id: qr.id },
      });
    }

    await this.prisma.quick_response_media.deleteMany({
      where: { quick_response_id: qr.id },
    });

    await this.prisma.quick_responses.delete({
      where: { id: qr.id },
    });

    return { success: true };
  }
}
