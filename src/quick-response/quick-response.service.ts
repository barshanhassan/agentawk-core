// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

// Replyagent's per-group message ceiling. Bumped from the prior 50 so a
// power user assembling a real canned-reply collection doesn't hit a
// surprise wall (replyagent's `QuickResponse::$limit = 100`).
const GROUP_MESSAGE_LIMIT = 100;
const VALID_SHARES = ['private', 'public', 'users', 'group'] as const;
const VALID_TYPES = ['text', 'media'] as const;

@Injectable()
export class QuickResponseService {
  private readonly logger = new Logger(QuickResponseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Parse the JSON-encoded `bindings` column safely. Replyagent stores it
   * as a JSON array of user IDs (numbers OR strings depending on Laravel
   * version), so we normalise to string IDs and avoid the previous
   * `contains: userId.toString()` Prisma filter that matched substrings
   * (user `12` would have leaked into a binding of `[120]`).
   */
  private parseBindings(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((x) => String(x));
    } catch {
      // ignore — return empty
    }
    return [];
  }

  /**
   * audit_logs writer for quick-response CRUD events.
   */
  private async audit(
    workspaceId: bigint,
    userId: bigint | null,
    event: string,
    qrId: bigint | null,
    data: any,
  ): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event,
          modelable_type: 'App\\Models\\QuickResponse',
          modelable_id: qrId,
          data: JSON.stringify(data ?? {}),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[quick-response] audit log failed (${event}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Create or update a quick-response message. Mirrors replyagent's
   * `QuickResponseController@createMessage`. Workspace isolation is
   * enforced on the parent group lookup so a leaked `group_id` from
   * another tenant can't be used to inject a message.
   */
  async createMessage(workspaceId: bigint, userId: bigint, data: any) {
    const { title, group_id, id, type, text, media_list } = data;

    if (!title || !group_id) {
      throw new BadRequestException('Title and group_id are required');
    }
    if (String(title).length > 80) {
      throw new BadRequestException('Title must be 80 characters or fewer');
    }
    const resolvedType = type || 'text';
    if (!(VALID_TYPES as readonly string[]).includes(resolvedType)) {
      throw new BadRequestException(
        `type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }

    const group = await this.prisma.quick_responses.findFirst({
      where: { id: BigInt(group_id), workspace_id: workspaceId, parent_id: null },
    });
    if (!group) {
      throw new BadRequestException('Invalid group');
    }

    let message: any;
    let isUpdate = false;
    if (id) {
      message = await this.prisma.quick_responses.findFirst({
        where: {
          id: BigInt(id),
          workspace_id: workspaceId,
          parent_id: group.id,
        },
      });
      if (!message) throw new NotFoundException('Message not found');
      isUpdate = true;

      message = await this.prisma.quick_responses.update({
        where: { id: message.id },
        data: {
          title,
          text: text ?? null,
          type: resolvedType,
        },
      });
    } else {
      const count = await this.prisma.quick_responses.count({
        where: { parent_id: group.id },
      });
      if (count >= GROUP_MESSAGE_LIMIT) {
        throw new BadRequestException(
          `Quick response limit reached for this group (${GROUP_MESSAGE_LIMIT})`,
        );
      }

      message = await this.prisma.quick_responses.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          parent_id: group.id,
          share: group.share,
          title,
          text: text ?? null,
          type: resolvedType,
        },
      });
    }

    // Media replacement is wholesale (matches replyagent). An empty array
    // therefore clears all attachments for this response.
    if (Array.isArray(media_list)) {
      await this.prisma.quick_response_media.deleteMany({
        where: { quick_response_id: message.id },
      });
      for (const media of media_list) {
        const galleryId = media?.id ?? media?.gallery_media_id;
        if (galleryId == null) continue;
        await this.prisma.quick_response_media.create({
          data: {
            quick_response_id: message.id,
            gallery_media_id: BigInt(galleryId),
          },
        });
      }
    }

    const eventName = isUpdate ? 'quick_response.updated' : 'quick_response.created';
    this.events.emit(eventName, {
      workspaceId,
      userId,
      qrId: message.id,
      parentId: group.id,
      title: message.title,
    });
    await this.audit(
      workspaceId,
      userId,
      isUpdate ? 'quick_response_updated' : 'quick_response_created',
      message.id,
      { title: message.title, parent_id: String(group.id), type: resolvedType },
    );

    const media = await this.prisma.quick_response_media.findMany({
      where: { quick_response_id: message.id },
    });

    return {
      success: true,
      qr: { ...message, mediaList: media },
      group,
    };
  }

  /**
   * Create or update a quick-response group (the "collection"). Bindings
   * stored as a JSON array of user IDs (stringified) — mirrors replyagent.
   */
  async createGroup(workspaceId: bigint, userId: bigint, data: any) {
    const { title, id, share, bindings } = data;

    if (!title) throw new BadRequestException('Title is required');
    if (String(title).length > 80) {
      throw new BadRequestException('Title must be 80 characters or fewer');
    }
    const resolvedShare = share || 'private';
    if (!(VALID_SHARES as readonly string[]).includes(resolvedShare)) {
      throw new BadRequestException(
        `share must be one of: ${VALID_SHARES.join(', ')}`,
      );
    }

    // Normalise bindings to a JSON array of string user IDs. Accept either
    // an array of {id, name} objects (replyagent's modern picker payload)
    // or a flat array of IDs.
    let bindingsJson: string | null = null;
    if (Array.isArray(bindings) && bindings.length > 0) {
      const ids = bindings
        .map((b: any) =>
          typeof b === 'object' && b !== null ? b.id ?? b.user_id : b,
        )
        .filter((x: any) => x !== undefined && x !== null)
        .map((x: any) => String(x));
      if (ids.length > 0) bindingsJson = JSON.stringify(ids);
    } else if (typeof bindings === 'string' && bindings.trim().startsWith('[')) {
      bindingsJson = bindings;
    }

    let group: any;
    let isUpdate = false;
    if (id) {
      group = await this.prisma.quick_responses.findFirst({
        where: { id: BigInt(id), workspace_id: workspaceId, parent_id: null },
      });
      if (!group) throw new NotFoundException('Group not found');
      isUpdate = true;

      group = await this.prisma.quick_responses.update({
        where: { id: group.id },
        data: {
          title,
          share: resolvedShare,
          bindings: bindingsJson,
        },
      });

      // Cascade `share` to all child messages so a private→public flip is
      // honoured by the visibility filter immediately.
      if (group.share === resolvedShare) {
        await this.prisma.quick_responses.updateMany({
          where: { parent_id: group.id },
          data: { share: resolvedShare },
        });
      }
    } else {
      group = await this.prisma.quick_responses.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          title,
          share: resolvedShare,
          bindings: bindingsJson,
        },
      });
    }

    this.events.emit(
      isUpdate ? 'quick_response_group.updated' : 'quick_response_group.created',
      { workspaceId, userId, groupId: group.id, title: group.title },
    );
    await this.audit(
      workspaceId,
      userId,
      isUpdate ? 'quick_response_group_updated' : 'quick_response_group_created',
      group.id,
      { title: group.title, share: resolvedShare },
    );

    return { success: true, group };
  }

  /**
   * Return the quick-response collections + messages visible to this user.
   * Visibility rules (mirrors replyagent):
   *   - owner: always sees their own rows
   *   - public: every workspace user sees it
   *   - users (selective): user's id must be in the parent group's bindings JSON
   *
   * Bindings parsing happens in JS (not Prisma's substring `contains` filter)
   * to avoid false positives where a literal substring matches an unrelated
   * user id.
   */
  async getResponse(workspaceId: bigint, userId: bigint) {
    const all = await this.prisma.quick_responses.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { id: 'asc' },
    });

    // Map of group id → parsed bindings to check selective share visibility
    // for child messages without re-parsing per row.
    const groupBindings = new Map<string, string[]>();
    for (const row of all) {
      if (row.parent_id == null) {
        groupBindings.set(
          String(row.id),
          this.parseBindings((row as any).bindings),
        );
      }
    }

    const userIdStr = String(userId);
    const isVisible = (row: any): boolean => {
      if (row.user_id === userId) return true;
      if (row.share === 'public') return true;
      if (row.share === 'users' || row.share === 'group') {
        // Selective sharing: child rows inherit the parent's bindings since
        // `share` is cascaded on group update. Look the parent up when the
        // row is a child.
        const targetGroupId = String(row.parent_id ?? row.id);
        const list = groupBindings.get(targetGroupId) ?? [];
        return list.includes(userIdStr);
      }
      return false;
    };

    const visibleResponses = all.filter(isVisible);

    // Attach mediaList to each visible message so the frontend doesn't need
    // a second round-trip. Group rows have no media so we skip the join.
    const messageIds = visibleResponses
      .filter((r: any) => r.parent_id != null)
      .map((r) => r.id);
    const media =
      messageIds.length === 0
        ? []
        : await this.prisma.quick_response_media.findMany({
            where: { quick_response_id: { in: messageIds } },
          });
    const mediaByQr = new Map<string, any[]>();
    for (const m of media) {
      const key = String(m.quick_response_id);
      if (!mediaByQr.has(key)) mediaByQr.set(key, []);
      mediaByQr.get(key)!.push(m);
    }

    const decorated = visibleResponses.map((r: any) => ({
      ...r,
      bindings: r.bindings ? this.parseBindings(r.bindings) : [],
      mediaList: mediaByQr.get(String(r.id)) ?? [],
    }));

    const folders = decorated.filter((r) => r.parent_id == null);

    return { responses: decorated, folders };
  }

  /**
   * Delete a quick-response or its parent group. Only the owner may delete
   * (matches replyagent) so a public response shared to the workspace
   * stays put when other agents try to drop it. Cascade deletes child
   * messages + media when removing a group.
   */
  async deleteResponse(workspaceId: bigint, userId: bigint, id: bigint) {
    const qr = await this.prisma.quick_responses.findFirst({
      where: { id, workspace_id: workspaceId },
    });

    if (!qr) throw new NotFoundException('Quick response not found');
    if (qr.user_id !== userId) {
      throw new ForbiddenException('Only the owner can delete this entry');
    }

    if (qr.parent_id === null) {
      // Collect child media to delete before removing the children themselves.
      const children = await this.prisma.quick_responses.findMany({
        where: { parent_id: qr.id },
        select: { id: true },
      });
      const childIds = children.map((c) => c.id);
      if (childIds.length > 0) {
        await this.prisma.quick_response_media.deleteMany({
          where: { quick_response_id: { in: childIds } },
        });
        await this.prisma.quick_responses.deleteMany({
          where: { id: { in: childIds } },
        });
      }
    }

    await this.prisma.quick_response_media.deleteMany({
      where: { quick_response_id: qr.id },
    });
    await this.prisma.quick_responses.delete({ where: { id: qr.id } });

    const isGroup = qr.parent_id === null;
    this.events.emit(
      isGroup ? 'quick_response_group.deleted' : 'quick_response.deleted',
      { workspaceId, userId, id: qr.id },
    );
    await this.audit(
      workspaceId,
      userId,
      isGroup ? 'quick_response_group_deleted' : 'quick_response_deleted',
      qr.id,
      { title: qr.title, parent_id: qr.parent_id ? String(qr.parent_id) : null },
    );

    return { success: true };
  }
}
