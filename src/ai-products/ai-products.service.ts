// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AI Products — replyagent parity for the `ai_products` model.
 *
 * Products belong to an `ai_theme`. Each one carries:
 *   - `external_id` (Baserow row id / Supabase pk),
 *   - `name`        display name,
 *   - `payload`     optional static JSON payload merged into the agent's reply,
 *   - `link_text`   override label for the trigger URL,
 *   - `trigger_url` deep link generated server-side after save,
 *   - `properties`  arbitrary JSON metadata (column → value snapshot).
 *
 * Mirrors `gateway/app/Http/Controllers/Api/AI/ProductsController.php`.
 */
@Injectable()
export class AiProductsService {
  private readonly logger = new Logger(AiProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── List / store / update / delete ──────────────────────────────────

  async list(workspaceId: bigint, themeId: bigint) {
    const theme = await this.findTheme(workspaceId, themeId);
    const products = await this.prisma.ai_products.findMany({
      where: { workspace_id: workspaceId, ai_theme_id: theme.id },
      orderBy: { created_at: 'desc' },
    });
    return {
      products: products.map(this.normaliseProduct),
    };
  }

  async create(workspaceId: bigint, themeId: bigint, body: any) {
    const theme = await this.findTheme(workspaceId, themeId);
    const validated = this.validateProductBody(body);

    // Always (re)generate the trigger URL on create — uniqueness is enforced
    // by combining a random slug with the theme id so two products under
    // different themes can share the same name.
    const triggerUrl = this.makeTriggerUrl(theme.id);

    const product = await this.prisma.ai_products.create({
      data: {
        workspace_id: workspaceId,
        ai_theme_id: theme.id,
        external_id: validated.external_id,
        name: validated.name,
        payload: validated.payload,
        link_text: validated.link_text,
        trigger_url: triggerUrl,
        properties: validated.properties,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { product: this.normaliseProduct(product) };
  }

  async update(
    workspaceId: bigint,
    themeId: bigint,
    productId: bigint,
    body: any,
  ) {
    const theme = await this.findTheme(workspaceId, themeId);
    const product = await this.findProduct(workspaceId, theme.id, productId);
    const validated = this.validateProductBody(body);

    const updated = await this.prisma.ai_products.update({
      where: { id: product.id },
      data: {
        external_id: validated.external_id,
        name: validated.name,
        payload: validated.payload,
        link_text: validated.link_text,
        properties: validated.properties,
        updated_at: new Date(),
      },
    });
    return { product: this.normaliseProduct(updated) };
  }

  async delete(workspaceId: bigint, themeId: bigint, productId: bigint) {
    const theme = await this.findTheme(workspaceId, themeId);
    const product = await this.findProduct(workspaceId, theme.id, productId);
    await this.prisma.ai_products.delete({ where: { id: product.id } });
    return { success: true };
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

  private async findProduct(workspaceId: bigint, themeId: bigint, productId: bigint) {
    const product = await this.prisma.ai_products.findFirst({
      where: { id: productId, workspace_id: workspaceId, ai_theme_id: themeId },
    });
    if (!product) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'AI Product not found',
      });
    }
    return product;
  }

  private validateProductBody(body: any) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name is required');
    if (name.length > 255) throw new BadRequestException('name must be 255 chars or fewer');

    return {
      name,
      external_id:
        body?.external_id != null && body.external_id !== ''
          ? String(body.external_id).slice(0, 255)
          : null,
      payload:
        body?.payload != null && body.payload !== ''
          ? typeof body.payload === 'string'
            ? body.payload.slice(0, 255)
            : JSON.stringify(body.payload).slice(0, 255)
          : null,
      link_text:
        body?.link_text != null && body.link_text !== ''
          ? String(body.link_text).slice(0, 255)
          : null,
      properties:
        body?.properties != null
          ? typeof body.properties === 'string'
            ? body.properties
            : JSON.stringify(body.properties)
          : null,
    };
  }

  /** Random 24-char slug — matches the kind of URLs replyagent emits.
   *  Stored on the row; the public AI agent dereferences `trigger_url` to
   *  resolve the right product when a contact sends the link. */
  private makeTriggerUrl(themeId: bigint): string {
    const slug = crypto.randomBytes(12).toString('hex');
    return `/v1/ai/products/${themeId.toString()}/${slug}`;
  }

  private normaliseProduct = (product: any) => ({
    ...product,
    id: product.id.toString(),
    workspace_id: product.workspace_id.toString(),
    ai_theme_id: product.ai_theme_id.toString(),
    properties: this.safeParseJson(product.properties) ?? null,
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
