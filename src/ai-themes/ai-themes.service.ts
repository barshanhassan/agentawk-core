// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AI Themes — replyagent parity for the `ai_themes` model.
 *
 * Themes are workspace-scoped database / spreadsheet templates that AI
 * agents read products from. Each theme has a `type` (BASEROW / SUPABASE /
 * other), an automation it's bound to, the channel it answers on, and the
 * column-to-question mapping in `properties` (JSON-encoded). The optional
 * `payload` is the static template the agent emits when matching products.
 *
 * Mirrors `gateway/app/Http/Controllers/Api/AI/ThemesController.php`.
 *
 * Per-theme user access (polymorphic): when a workspace agent isn't an
 * `owner` or `super_user`, they can only see themes they were granted
 * access to via the `user_accesses` table (`accessable_type =
 * 'App\\Models\\AI\\AITheme'`). Mirrors Laravel's
 * `User::accessableAiThemes()` relationship + the `getUsers / toggleUserAccess`
 * endpoints.
 */
@Injectable()
export class AiThemesService {
  private readonly logger = new Logger(AiThemesService.name);

  // Polymorphic identifier — must match the value stored by Laravel so the
  // pivot rows work for both code paths.
  private static readonly POLYMORPHIC_TYPE = 'App\\Models\\AI\\AITheme';

  constructor(private readonly prisma: PrismaService) {}

  // ─── List / show ─────────────────────────────────────────────────────

  async list(workspaceId: bigint, userId: bigint, roleSlug: string, type?: string) {
    const isPrivileged = roleSlug === 'owner' || roleSlug === 'super_user';

    const where: any = {
      workspace_id: workspaceId,
      ...(type ? { type } : {}),
    };

    if (!isPrivileged) {
      // Non-privileged users only see themes they have access to via the
      // `user_accesses` pivot.
      const accessRows = await this.prisma.user_accesses.findMany({
        where: { user_id: userId, accessable_type: AiThemesService.POLYMORPHIC_TYPE },
        select: { accessable_id: true },
      });
      const allowedIds = accessRows.map((r) => r.accessable_id);
      if (allowedIds.length === 0) return { themes: [] };
      where.id = { in: allowedIds };
    }

    const themes = await this.prisma.ai_themes.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });

    return { themes: themes.map(this.normaliseTheme) };
  }

  async show(workspaceId: bigint, themeId: bigint) {
    const theme = await this.findTheme(workspaceId, themeId);
    return { theme: this.normaliseTheme(theme) };
  }

  // ─── Create / update / delete ────────────────────────────────────────

  async create(workspaceId: bigint, body: any) {
    const validated = this.validateThemeBody(body);

    const theme = await this.prisma.ai_themes.create({
      data: {
        workspace_id: workspaceId,
        name: validated.name,
        subtitle: validated.subtitle,
        type: validated.type,
        automation_id: validated.automation_id,
        channel: validated.channel,
        payload: validated.payload,
        properties: validated.properties,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { theme: this.normaliseTheme(theme) };
  }

  async update(workspaceId: bigint, themeId: bigint, body: any) {
    const theme = await this.findTheme(workspaceId, themeId);
    const validated = this.validateThemeBody(body);

    // Replyagent's `payload_enabled=false` zeroes out payload — mirror the
    // same behaviour so toggling the editor's switch off persists clean.
    const payload = body.payload_enabled === false ? null : validated.payload;

    const updated = await this.prisma.ai_themes.update({
      where: { id: theme.id },
      data: {
        name: validated.name,
        subtitle: validated.subtitle,
        type: validated.type,
        automation_id: validated.automation_id,
        channel: validated.channel,
        payload,
        properties: validated.properties,
        updated_at: new Date(),
      },
    });

    return { theme: this.normaliseTheme(updated) };
  }

  async delete(workspaceId: bigint, themeId: bigint) {
    const theme = await this.findTheme(workspaceId, themeId);

    // Cascade: wipe per-theme product rows + user-access pivots before the
    // theme itself, otherwise we'd leave orphans (no DB-level FK in Prisma).
    await this.prisma.ai_products.deleteMany({ where: { ai_theme_id: theme.id } });
    await this.prisma.user_accesses.deleteMany({
      where: {
        accessable_type: AiThemesService.POLYMORPHIC_TYPE,
        accessable_id: theme.id,
      },
    });
    await this.prisma.ai_themes.delete({ where: { id: theme.id } });

    return { success: true };
  }

  // ─── User access management ──────────────────────────────────────────

  async listUsers(workspaceId: bigint, themeId: bigint) {
    const theme = await this.findTheme(workspaceId, themeId);
    const rows = await this.prisma.user_accesses.findMany({
      where: {
        accessable_type: AiThemesService.POLYMORPHIC_TYPE,
        accessable_id: theme.id,
      },
      select: { user_id: true },
    });
    return { user_ids: rows.map((r) => r.user_id.toString()) };
  }

  async toggleUserAccess(
    workspaceId: bigint,
    themeId: bigint,
    targetUserId: bigint,
    access: boolean,
  ) {
    const theme = await this.findTheme(workspaceId, themeId);

    // syncWithoutDetaching / detach parity — upsert when access=true, delete
    // when access=false.
    if (access) {
      const existing = await this.prisma.user_accesses.findFirst({
        where: {
          user_id: targetUserId,
          accessable_type: AiThemesService.POLYMORPHIC_TYPE,
          accessable_id: theme.id,
        },
      });
      if (!existing) {
        await this.prisma.user_accesses.create({
          data: {
            user_id: targetUserId,
            accessable_type: AiThemesService.POLYMORPHIC_TYPE,
            accessable_id: theme.id,
          },
        });
      }
    } else {
      await this.prisma.user_accesses.deleteMany({
        where: {
          user_id: targetUserId,
          accessable_type: AiThemesService.POLYMORPHIC_TYPE,
          accessable_id: theme.id,
        },
      });
    }

    return { success: true, access };
  }

  // ─── Baserow fields proxy ─────────────────────────────────────────────

  /**
   * Fetches the field list for the table the theme is bound to, straight
   * from Baserow's REST API. Used by the theme-edit UI to populate the
   * column-to-question mapper. Mirrors `ThemesController::fields`.
   */
  async fetchBaserowFields(workspaceId: bigint, themeId: bigint) {
    const theme = await this.findTheme(workspaceId, themeId);
    if (theme.type !== 'baserow' && theme.type !== 'BASEROW') {
      throw new BadRequestException('Field lookup only available for Baserow themes');
    }

    const account = await this.prisma.baserow_accounts.findFirst({
      where: { workspace_id: workspaceId },
    });
    if (!account || !account.access_token) {
      throw new BadRequestException('Baserow integration is not connected for this workspace');
    }

    const properties = this.safeParseJson(theme.properties);
    const tableId =
      properties?.spreadsheet_id ?? properties?.table_id ?? properties?.tableId;
    if (!tableId) {
      throw new BadRequestException(
        'Theme properties missing spreadsheet_id (Baserow table id)',
      );
    }

    try {
      const res = await fetch(
        `https://api.baserow.io/api/database/fields/table/${tableId}/`,
        {
          headers: { Authorization: `Token ${account.access_token}` },
        },
      );
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
      if (!res.ok) {
        throw new BadRequestException(
          `Baserow error: ${body?.detail ?? body?.error ?? `HTTP ${res.status}`}`,
        );
      }
      return { fields: body };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`Baserow fields fetch failed: ${e?.message ?? e}`);
      throw new BadRequestException('Failed to fetch Baserow fields');
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private async findTheme(workspaceId: bigint, themeId: bigint) {
    const theme = await this.prisma.ai_themes.findFirst({
      where: { id: themeId, workspace_id: workspaceId },
    });
    if (!theme) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'AI Theme not found',
      });
    }
    return theme;
  }

  private validateThemeBody(body: any) {
    const name = String(body?.name ?? '').trim();
    const subtitle = String(body?.subtitle ?? '').trim();
    const type = String(body?.type ?? '').trim();
    const channel =
      body?.channel != null && body.channel !== ''
        ? typeof body.channel === 'string'
          ? body.channel
          : JSON.stringify(body.channel)
        : null;
    const automationIdRaw = body?.automation_id;
    const automationId =
      automationIdRaw != null && automationIdRaw !== '' ? BigInt(automationIdRaw) : null;

    if (!name) throw new BadRequestException('name is required');
    if (name.length > 255) throw new BadRequestException('name must be 255 chars or fewer');
    if (!subtitle) throw new BadRequestException('subtitle is required');
    if (subtitle.length > 1024)
      throw new BadRequestException('subtitle must be 1024 chars or fewer');
    if (!type) throw new BadRequestException('type is required');
    if (!automationId) throw new BadRequestException('automation_id is required');
    if (!channel) throw new BadRequestException('channel is required');

    return {
      name,
      subtitle,
      type,
      automation_id: automationId,
      channel,
      payload:
        body?.payload != null && body.payload !== ''
          ? typeof body.payload === 'string'
            ? body.payload
            : JSON.stringify(body.payload)
          : null,
      properties:
        body?.properties != null
          ? typeof body.properties === 'string'
            ? body.properties
            : JSON.stringify(body.properties)
          : null,
    };
  }

  /** Parse JSON-encoded columns + stringify bigints so the UI gets clean
   *  primitives. */
  private normaliseTheme = (theme: any) => ({
    ...theme,
    id: theme.id.toString(),
    workspace_id: theme.workspace_id.toString(),
    automation_id: theme.automation_id ? theme.automation_id.toString() : null,
    properties: this.safeParseJson(theme.properties) ?? null,
    channel: this.safeParseJson(theme.channel) ?? theme.channel,
  });

  private safeParseJson(raw: any): any {
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}
