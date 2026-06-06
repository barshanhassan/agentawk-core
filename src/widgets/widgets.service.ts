// @ts-nocheck
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

// Replyagent's channel set on a chat widget. Each channel takes a model_type
// + model object so the widget knows what to surface (e.g. WhatsApp number,
// Telegram bot, Facebook page).
const CHANNELS = [
  'sms',
  'call',
  'email',
  'instagram',
  'telegram',
  'messenger',
  'whatsapp',
  'zapi',
] as const;
const VALID_POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const;

@Injectable()
export class WidgetsService {
  private readonly logger = new Logger(WidgetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Generate a timestamp-prefixed slug. Replyagent uses `microtime()` so
   * collisions are effectively impossible — we mirror that with a Date-based
   * radix-36 string plus a short random suffix as a safety net.
   */
  private newSlug(): string {
    return (Date.now().toString(36) + Math.floor(1e4 + Math.random() * 9e4).toString(36)).slice(
      0,
      32,
    );
  }

  /**
   * Channel-option payload the frontend dropdowns consume. Mirrors
   * replyagent's `getWidgetData` shape — `{channels, activities}` per
   * channel — so the existing UI binding code carries over without
   * translation.
   */
  /**
   * Channel-option payload the frontend dropdowns consume. Model + column
   * names verified against `prisma/schema.prisma` — do NOT rename without
   * re-checking; replyagent's `facebook_pages` / `instagram_pages` are
   * `fb_pages` / `insta_pages` in EZCONN's schema. Twilio numbers don't
   * carry `workspace_id` directly — they hang off `twilio_accounts.workspace_id`.
   *
   * Each block is `.catch(() => [])` so a missing channel table never
   * 500s the widget settings page.
   */
  async getChannelOptions(workspaceId: bigint) {
    const [
      waAccounts,
      telegramBots,
      fbPages,
      instaPages,
      zapiInstances,
      twilioNumbers,
    ] = await Promise.all([
      this.prisma.wa_accounts
        .findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, waba_id: true },
        })
        .catch(() => []),
      this.prisma.telegram_bots
        .findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, tg_name: true, slug: true },
        })
        .catch(() => []),
      this.prisma.fb_pages
        .findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, page_id: true, username: true },
        })
        .catch(() => []),
      this.prisma.insta_pages
        .findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: {
            id: true,
            name: true,
            username: true,
            ig_user_id: true,
          },
        })
        .catch(() => []),
      this.prisma.zapi_instances
        .findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, phone_number: true },
        })
        .catch(() => []),
      // Twilio numbers belong to twilio_accounts → workspace, so we join
      // through accounts here. `.catch` keeps the call resilient if the
      // account/number tables are empty.
      this.prisma.twilio_numbers
        .findMany({
          where: {
            deleted_at: null,
            twilio_accounts: { workspace_id: workspaceId },
          },
          select: {
            id: true,
            twilio_phone_number: true,
            type: true,
          },
        })
        .catch(() => []),
    ]);

    // Normalise each row into a `{id, name, ...}` shape the frontend dropdown
    // can consume without bespoke per-channel mapping logic. `name` is the
    // human-readable label; the underlying id is preserved on `id`.
    const normalise = {
      wa: waAccounts.map((x: any) => ({
        id: x.id,
        name: x.name || x.waba_id || `WABA #${x.id}`,
        waba_id: x.waba_id,
      })),
      tg: telegramBots.map((x: any) => ({
        id: x.id,
        name: x.tg_name || x.name || `Bot #${x.id}`,
        slug: x.slug,
        username: x.tg_name,
      })),
      fb: fbPages.map((x: any) => ({
        id: x.id,
        name: x.name || x.username || `Page #${x.id}`,
        page_id: x.page_id,
      })),
      ig: instaPages.map((x: any) => ({
        id: x.id,
        name: x.name || x.username || `IG #${x.id}`,
        username: x.username,
        ig_user_id: x.ig_user_id,
      })),
      zapi: zapiInstances.map((x: any) => ({
        id: x.id,
        name: x.name || x.phone_number || `Z-API #${x.id}`,
        phone: x.phone_number,
      })),
      tw: twilioNumbers.map((x: any) => ({
        id: x.id,
        phone_number: x.twilio_phone_number,
        friendly_name: x.twilio_phone_number,
        type: x.type,
      })),
    };

    return {
      whatsapp: { channels: normalise.wa.map((x) => this.stringifyIds(x)), activities: [] },
      telegram: { bots: normalise.tg.map((x) => this.stringifyIds(x)), activities: [] },
      messenger: { pages: normalise.fb.map((x) => this.stringifyIds(x)), activities: [] },
      instagram: { pages: normalise.ig.map((x) => this.stringifyIds(x)), activities: [] },
      zapi: { channels: normalise.zapi.map((x) => this.stringifyIds(x)), activities: [] },
      twilio_numbers: normalise.tw.map((x) => this.stringifyIds(x)),
    };
  }

  /**
   * BigInt-safe shallow clone — frontend can't parse raw BigInts and the
   * server's existing controllers stringify ids manually. Centralising it
   * here keeps the wire shape consistent.
   */
  private stringifyIds<T extends object>(row: T): T {
    const out: any = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? v.toString() : v;
    }
    return out;
  }

  async getWidgets(workspaceId: bigint) {
    const widgets = await this.prisma.widgets.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { created_at: 'asc' },
    });

    const widgetIds = widgets.map((w) => w.id);
    const actions =
      widgetIds.length === 0
        ? []
        : await this.prisma.widget_actions.findMany({
            where: { widget_id: { in: widgetIds } },
          });
    const actionsByWidget = new Map<string, any[]>();
    for (const a of actions) {
      const key = String(a.widget_id);
      if (!actionsByWidget.has(key)) actionsByWidget.set(key, []);
      actionsByWidget.get(key)!.push({
        ...this.stringifyIds(a),
        // `model` is stored as JSON text — parse for the UI so it can
        // populate the channel dropdown without doing the JSON.parse
        // dance itself.
        model: a.model ? this.safeParse(a.model) : null,
      });
    }

    const decorated = widgets.map((w: any) => ({
      ...this.stringifyIds(w),
      actions: actionsByWidget.get(String(w.id)) ?? [],
    }));

    const options = await this.getChannelOptions(workspaceId);

    return {
      widgets: decorated,
      ...options,
    };
  }

  async createWidget(workspaceId: bigint, userId: bigint | null, data: any) {
    const {
      id,
      name,
      title,
      subtitle,
      header_bg,
      body_bg,
      font_family,
      position,
      icon,
      actions,
    } = data;

    if (!name || !String(name).trim()) {
      throw new BadRequestException('Widget name is required');
    }
    if (!title || !String(title).trim()) {
      throw new BadRequestException('Widget title is required');
    }
    const resolvedPosition = position || 'bottom-right';
    if (!(VALID_POSITIONS as readonly string[]).includes(resolvedPosition)) {
      throw new BadRequestException(
        `position must be one of: ${VALID_POSITIONS.join(', ')}`,
      );
    }
    const hexish = (v: any) => {
      if (!v) return null;
      const s = String(v).trim();
      // accept #RGB, #RRGGBB, #RRGGBBAA, or rgba(...) — anything else is
      // probably a client bug we don't want to silently persist.
      return /^#([0-9a-f]{3,8})$/i.test(s) || /^rgba?\(/i.test(s) ? s : null;
    };
    const headerBg = hexish(header_bg) ?? '#ffffff';
    const bodyBg = hexish(body_bg) ?? '#ffffff';
    const fontFamily = (font_family ?? 'Inter').toString().slice(0, 20);

    let widget: any;
    let isUpdate = false;
    if (id) {
      widget = await this.prisma.widgets.findFirst({
        where: { id: BigInt(id), workspace_id: workspaceId },
      });
      if (!widget) throw new NotFoundException('Widget not found');
      isUpdate = true;

      widget = await this.prisma.widgets.update({
        where: { id: widget.id },
        data: {
          name,
          title,
          subtitle: subtitle ?? null,
          header_bg: headerBg,
          body_bg: bodyBg,
          font_family: fontFamily,
          position: resolvedPosition,
          icon: icon ?? widget.icon,
        },
      });
    } else {
      widget = await this.prisma.widgets.create({
        data: {
          workspace_id: workspaceId,
          name,
          title,
          subtitle: subtitle ?? null,
          slug: this.newSlug(),
          header_bg: headerBg,
          body_bg: bodyBg,
          font_family: fontFamily,
          position: resolvedPosition,
          icon: icon ?? null,
        },
      });
    }

    // Replace widget_actions wholesale — the form's "save channels" UX is
    // simpler this way and matches replyagent's destroy-then-create cycle.
    if (Array.isArray(actions)) {
      await this.prisma.widget_actions.deleteMany({
        where: { widget_id: widget.id },
      });
      for (const action of actions) {
        const channel = (action?.channel ?? '').toString().toLowerCase();
        if (!(CHANNELS as readonly string[]).includes(channel)) continue;
        await this.prisma.widget_actions.create({
          data: {
            widget_id: widget.id,
            channel,
            model_type: (action?.model_type ?? '').toString().slice(0, 30),
            model:
              typeof action?.model === 'string'
                ? action.model
                : JSON.stringify(action?.model ?? {}),
            modelable_id: action?.modelable_id
              ? BigInt(action.modelable_id)
              : null,
            modelable_type: action?.modelable_type ?? null,
            activity_slug: action?.activity_slug ?? null,
          },
        });
      }
    }

    this.events.emit(isUpdate ? 'widget.updated' : 'widget.created', {
      workspaceId,
      widgetId: widget.id,
      slug: widget.slug,
      name: widget.name,
    });
    await this.audit(
      workspaceId,
      userId,
      isUpdate ? 'widget_updated' : 'widget_created',
      widget.id,
      { name: widget.name, slug: widget.slug, position: resolvedPosition },
    );

    // Return widget with its actions so the frontend doesn't need another
    // round-trip after save.
    const persistedActions = await this.prisma.widget_actions.findMany({
      where: { widget_id: widget.id },
    });
    return {
      ...this.stringifyIds(widget),
      actions: persistedActions.map((a: any) => ({
        ...this.stringifyIds(a),
        model: a.model ? this.safeParse(a.model) : null,
      })),
    };
  }

  async deleteWidget(workspaceId: bigint, userId: bigint | null, id: bigint) {
    const existing = await this.prisma.widgets.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!existing) throw new NotFoundException('Widget not found');

    await this.prisma.widget_actions.deleteMany({ where: { widget_id: id } });
    await this.prisma.widgets.delete({ where: { id } });

    this.events.emit('widget.deleted', { workspaceId, widgetId: id });
    await this.audit(workspaceId, userId, 'widget_deleted', id, {
      name: existing.name,
    });

    return { success: true };
  }

  private safeParse(s: string): any {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }

  private async audit(
    workspaceId: bigint,
    userId: bigint | null,
    event: string,
    widgetId: bigint | null,
    data: any,
  ): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event,
          modelable_type: 'App\\Models\\Widget\\Widget',
          modelable_id: widgetId,
          data: JSON.stringify(data ?? {}),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[widgets] audit log failed (${event}): ${err?.message ?? err}`,
      );
    }
  }
}
