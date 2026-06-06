// @ts-nocheck
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

// Replyagent caps the iframe count per workspace at 3 — kept exactly so the
// frontend warning text stays accurate.
const IFRAME_LIMIT = 3;
const VALID_PLACEMENTS = ['settings_menu', 'main_menu'] as const;

@Injectable()
export class IframesService {
  private readonly logger = new Logger(IframesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Fetch all iframes for the workspace + the menu title + permission
   * rows for the per-user grant grid. The new `placement`, `icon` and
   * `menu_text` columns are pulled via raw SQL to side-step the locked
   * Prisma client (regenerated client picks them up on next backend
   * restart and the raw query becomes optional then).
   */
  async getIframes(workspaceId: bigint) {
    const iframes = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, workspace_id, name, menu, placement, icon, menu_text, html, created_at, updated_at
         FROM iframes
        WHERE workspace_id = ?
        ORDER BY created_at ASC`,
      workspaceId,
    );

    const ids = iframes.map((i) => i.id);
    const permissions =
      ids.length === 0
        ? []
        : await this.prisma.iframe_permissions.findMany({
            where: { iframe_id: { in: ids.map((x: any) => BigInt(x)) } },
          });

    const permsByIframe = new Map<string, any[]>();
    for (const p of permissions) {
      const key = String(p.iframe_id);
      if (!permsByIframe.has(key)) permsByIframe.set(key, []);
      permsByIframe.get(key)!.push({
        id: String(p.id),
        user_id: String(p.user_id),
      });
    }

    const decorated = iframes.map((i: any) => ({
      ...i,
      id: String(i.id),
      workspace_id: String(i.workspace_id),
      permissions: permsByIframe.get(String(i.id)) ?? [],
    }));

    const menu = await this.prisma.iframe_menus.findFirst({
      where: { workspace_id: workspaceId },
    });

    return {
      iframes: decorated,
      menu_title: menu?.name || 'Iframes',
    };
  }

  /**
   * Single iframe lookup — mirrors replyagent's `show` route. Used by the
   * permissions tab so the picker can render even without re-fetching the
   * full list.
   */
  async getIframe(workspaceId: bigint, id: bigint) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, workspace_id, name, menu, placement, icon, menu_text, html, created_at, updated_at
         FROM iframes WHERE id = ? AND workspace_id = ? LIMIT 1`,
      id,
      workspaceId,
    );
    const iframe = rows?.[0];
    if (!iframe) throw new NotFoundException('Iframe not found');
    const permissions = await this.prisma.iframe_permissions.findMany({
      where: { iframe_id: id },
    });
    return {
      iframe: {
        ...iframe,
        id: String(iframe.id),
        workspace_id: String(iframe.workspace_id),
        permissions: permissions.map((p: any) => ({
          id: String(p.id),
          user_id: String(p.user_id),
        })),
      },
    };
  }

  async saveIframe(
    workspaceId: bigint,
    userId: bigint | null,
    data: any,
  ) {
    const id = data.id ? BigInt(data.id) : null;
    const name = (data.name ?? '').toString().trim();
    if (!name) throw new BadRequestException('Name is required');
    if (name.length > 255)
      throw new BadRequestException('Name must be 255 characters or fewer');

    const placement = data.placement ?? 'settings_menu';
    if (!(VALID_PLACEMENTS as readonly string[]).includes(placement)) {
      throw new BadRequestException(
        `placement must be one of: ${VALID_PLACEMENTS.join(', ')}`,
      );
    }

    // settings_menu requires a menu group; main_menu uses the iframe name
    // directly.
    const menu =
      placement === 'settings_menu'
        ? (data.menu ?? data.menu_text ?? null)
        : null;
    const menuText = data.menu_text ?? data.menu ?? null;
    const icon = data.icon ?? null;
    const html = data.html ?? data.html_code ?? '';

    if (id) {
      const existing = await this.prisma.iframes.findFirst({
        where: { id, workspace_id: workspaceId },
      });
      if (!existing) throw new NotFoundException('Iframe not found');

      await this.prisma.$executeRawUnsafe(
        `UPDATE iframes
            SET name = ?, menu = ?, placement = ?, icon = ?, menu_text = ?, html = ?, updated_at = NOW()
          WHERE id = ?`,
        name,
        menu,
        placement,
        icon,
        menuText,
        html,
        id,
      );
      const updated = await this.getIframe(workspaceId, id);
      this.events.emit('iframe.updated', {
        workspaceId,
        iframeId: id,
        name,
      });
      await this.audit(workspaceId, userId, 'iframe_updated', id, {
        name,
        placement,
      });
      return updated.iframe;
    }

    const count = await this.prisma.iframes.count({
      where: { workspace_id: workspaceId },
    });
    if (count >= IFRAME_LIMIT) {
      throw new BadRequestException(
        `Maximum ${IFRAME_LIMIT} iframes allowed per workspace`,
      );
    }

    const result: any = await this.prisma.$executeRawUnsafe(
      `INSERT INTO iframes (workspace_id, name, menu, placement, icon, menu_text, html, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      workspaceId,
      name,
      menu,
      placement,
      icon,
      menuText,
      html,
    );
    // Resolve the new row — mysql doesn't return LASTROW from $executeRawUnsafe.
    const created = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, workspace_id, name, menu, placement, icon, menu_text, html, created_at, updated_at
         FROM iframes WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
      workspaceId,
    );
    const row = created?.[0];
    if (!row) {
      throw new BadRequestException('Failed to create iframe');
    }

    this.events.emit('iframe.created', {
      workspaceId,
      iframeId: row.id,
      name,
    });
    await this.audit(workspaceId, userId, 'iframe_created', BigInt(row.id), {
      name,
      placement,
    });

    return {
      ...row,
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      permissions: [],
    };
  }

  async deleteIframe(workspaceId: bigint, userId: bigint | null, id: bigint) {
    const existing = await this.prisma.iframes.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!existing) throw new NotFoundException('Iframe not found');

    await this.prisma.iframe_permissions.deleteMany({
      where: { iframe_id: id },
    });
    await this.prisma.iframes.delete({ where: { id } });

    this.events.emit('iframe.deleted', { workspaceId, iframeId: id });
    await this.audit(workspaceId, userId, 'iframe_deleted', id, {
      name: existing.name,
    });

    return { success: true };
  }

  async updateMenuTitle(
    workspaceId: bigint,
    userId: bigint | null,
    title: string,
  ) {
    const existing = await this.prisma.iframe_menus.findFirst({
      where: { workspace_id: workspaceId },
    });

    if (existing) {
      await this.prisma.iframe_menus.update({
        where: { id: existing.id },
        data: { name: title },
      });
    } else {
      await this.prisma.iframe_menus.create({
        data: { workspace_id: workspaceId, name: title },
      });
    }

    this.events.emit('iframe.menu_title_updated', { workspaceId, title });
    await this.audit(workspaceId, userId, 'iframe_menu_title_updated', null, {
      title,
    });
    return { success: true };
  }

  /**
   * Replace the per-user permission grants for an iframe. Body shape mirrors
   * replyagent's `permissions` endpoint: `{ permissions: [{ user_id }] }`.
   * Existing grants are wiped and replaced so the UI's "save selected"
   * model maps cleanly.
   */
  async setPermissions(
    workspaceId: bigint,
    userId: bigint | null,
    iframeId: bigint,
    userIds: bigint[],
  ) {
    const existing = await this.prisma.iframes.findFirst({
      where: { id: iframeId, workspace_id: workspaceId },
    });
    if (!existing) throw new NotFoundException('Iframe not found');

    await this.prisma.iframe_permissions.deleteMany({
      where: { iframe_id: iframeId },
    });
    if (userIds.length > 0) {
      const now = new Date();
      for (const uid of userIds) {
        await this.prisma.iframe_permissions.create({
          data: {
            iframe_id: iframeId,
            user_id: uid,
            created_at: now,
            updated_at: now,
          },
        });
      }
    }

    this.events.emit('iframe.permissions_updated', {
      workspaceId,
      iframeId,
      userIds: userIds.map(String),
    });
    await this.audit(
      workspaceId,
      userId,
      'iframe_permissions_updated',
      iframeId,
      { count: userIds.length },
    );

    return { success: true, count: userIds.length };
  }

  private async audit(
    workspaceId: bigint,
    userId: bigint | null,
    event: string,
    iframeId: bigint | null,
    data: any,
  ): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event,
          modelable_type: 'App\\Models\\Iframes\\Iframe',
          modelable_id: iframeId,
          data: JSON.stringify(data ?? {}),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[iframes] audit log failed (${event}): ${err?.message ?? err}`,
      );
    }
  }
}
