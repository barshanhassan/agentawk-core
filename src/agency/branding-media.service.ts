import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';

export type BrandableType = 'AGENCY' | 'WORKSPACE';
export type LogoType =
  | 'logo_light'
  | 'logo_light_small'
  | 'logo_dark'
  | 'logo_dark_small';

const LOGO_FIELD_MAP: Record<LogoType, string> = {
  logo_light: 'mid_logo_light',
  logo_light_small: 'mid_logo_light_small',
  logo_dark: 'mid_logo_dark',
  logo_dark_small: 'mid_logo_dark_small',
};

const MAX_LOGO_SIZE = 400;
const MAX_FAVICON_SIZE = 32;

@Injectable()
export class BrandingMediaService {
  private readonly logger = new Logger(BrandingMediaService.name);
  private readonly uploadPath = path.join(process.cwd(), 'uploads');

  constructor(private readonly prisma: PrismaService) {
    if (!fs.existsSync(this.uploadPath)) {
      fs.mkdirSync(this.uploadPath, { recursive: true });
    }
  }

  // ─── Public: Logo ─────────────────────────────────────────────────────

  async uploadLogo(
    file: Express.Multer.File,
    logoType: LogoType,
    canvasData: any,
    brandableType: BrandableType,
    brandableId: bigint,
    workspaceId: bigint,
    userId: bigint,
  ) {
    if (!file) throw new BadRequestException('Invalid request');
    if (!logoType || !LOGO_FIELD_MAP[logoType])
      throw new BadRequestException('Invalid logo_id');

    const buffer = await this.processImage(
      file.buffer,
      MAX_LOGO_SIZE,
      MAX_LOGO_SIZE,
      canvasData,
    );

    const media = await this.persistMedia(
      buffer,
      file,
      brandableType,
      brandableId,
      workspaceId,
      userId,
    );

    await this.setBrandingField(
      brandableType,
      brandableId,
      LOGO_FIELD_MAP[logoType],
      media.id,
    );

    return { logo: media.file_url };
  }

  async updateLogo(
    mediaId: bigint,
    logoType: LogoType,
    brandableType: BrandableType,
    brandableId: bigint,
    userId: bigint,
  ) {
    if (!logoType || !LOGO_FIELD_MAP[logoType])
      throw new BadRequestException('Invalid logo_id');

    const media = await this.prisma.media_gallery.findUnique({
      where: { id: mediaId },
    });
    if (!media || media.user_id !== userId)
      throw new BadRequestException('Invalid media');

    await this.setBrandingField(
      brandableType,
      brandableId,
      LOGO_FIELD_MAP[logoType],
      media.id,
    );

    return { logo: media.file_url };
  }

  async removeLogo(
    logoType: LogoType,
    brandableType: BrandableType,
    brandableId: bigint,
  ) {
    if (!logoType || !LOGO_FIELD_MAP[logoType])
      throw new BadRequestException('Invalid logo type');
    await this.setBrandingField(
      brandableType,
      brandableId,
      LOGO_FIELD_MAP[logoType],
      null,
    );
    return { logo: null, message: 'Successfully updated' };
  }

  // ─── Public: Favicon ──────────────────────────────────────────────────

  async uploadFavicon(
    file: Express.Multer.File,
    canvasData: any,
    brandableType: BrandableType,
    brandableId: bigint,
    workspaceId: bigint,
    userId: bigint,
  ) {
    if (!file) throw new BadRequestException('Invalid request');

    const buffer = await this.processImage(
      file.buffer,
      MAX_FAVICON_SIZE,
      MAX_FAVICON_SIZE,
      canvasData,
    );

    const media = await this.persistMedia(
      buffer,
      file,
      brandableType,
      brandableId,
      workspaceId,
      userId,
    );

    await this.setBrandingField(
      brandableType,
      brandableId,
      'favicon_media_id',
      media.id,
    );

    return { favicon: media.file_url };
  }

  async updateFavicon(
    mediaId: bigint,
    brandableType: BrandableType,
    brandableId: bigint,
    userId: bigint,
  ) {
    const media = await this.prisma.media_gallery.findUnique({
      where: { id: mediaId },
    });
    if (!media || media.user_id !== userId)
      throw new BadRequestException('Invalid media');

    await this.setBrandingField(
      brandableType,
      brandableId,
      'favicon_media_id',
      media.id,
    );

    return { favicon: media.file_url };
  }

  async removeFavicon(brandableType: BrandableType, brandableId: bigint) {
    await this.setBrandingField(
      brandableType,
      brandableId,
      'favicon_media_id',
      null,
    );
    return { favicon: null, message: 'Successfully updated' };
  }

  /**
   * Hard-delete media records + disk files. Used by branding cleanup
   * (white-label cancel) to prevent orphaned uploads.
   *
   * Mirrors gateway's DeleteMedia::dispatchSync($id) loop in OnAgencyUpdated.
   */
  async deleteBrandingMedia(mediaIds: (bigint | null | undefined)[]): Promise<void> {
    const ids = mediaIds.filter((id): id is bigint => !!id);
    if (ids.length === 0) return;

    const media = await this.prisma.media_gallery.findMany({
      where: { id: { in: ids } },
    });

    // Delete files from disk first (best-effort), then DB rows
    for (const m of media) {
      if (m.file_path) {
        const fullPath = path.join(this.uploadPath, m.file_path);
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            this.logger.debug(`Deleted file ${fullPath}`);
          }
        } catch (err) {
          this.logger.warn(`Failed to delete file ${fullPath}: ${err.message}`);
        }
      }
    }

    await this.prisma.media_gallery.deleteMany({
      where: { id: { in: ids } },
    });
    this.logger.log(`Deleted ${ids.length} branding media records`);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Crops (if canvas_data given) and resizes within max bounds preserving
   * aspect ratio — matches Intervention Image flow used in gateway.
   */
  private async processImage(
    input: Buffer,
    maxWidth: number,
    maxHeight: number,
    canvasData: any,
  ): Promise<Buffer> {
    let pipeline = sharp(input);

    if (canvasData) {
      try {
        const cd =
          typeof canvasData === 'string' ? JSON.parse(canvasData) : canvasData;
        if (
          cd &&
          cd.width != null &&
          cd.height != null &&
          cd.x != null &&
          cd.y != null
        ) {
          pipeline = pipeline.extract({
            left: parseInt(cd.x),
            top: parseInt(cd.y),
            width: parseInt(cd.width),
            height: parseInt(cd.height),
          });
        }
      } catch (err) {
        this.logger.warn(`Invalid canvas_data, skipping crop: ${err.message}`);
      }
    }

    pipeline = pipeline.resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });

    return pipeline.toBuffer();
  }

  private async persistMedia(
    buffer: Buffer,
    file: Express.Multer.File,
    brandableType: BrandableType,
    brandableId: bigint,
    workspaceId: bigint,
    userId: bigint,
  ) {
    const objectId =
      Math.floor(Date.now() / 1000) +
      '_' +
      crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname) || '.png';
    const fileName = `${objectId}${ext}`;
    const fullPath = path.join(this.uploadPath, fileName);

    fs.writeFileSync(fullPath, buffer);

    const modelable_type =
      brandableType === 'AGENCY'
        ? 'App\\Models\\Agency'
        : 'App\\Models\\Workspace';

    return this.prisma.media_gallery.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        modelable_id: brandableId,
        modelable_type: modelable_type,
        object_id: objectId,
        object_name: file.originalname,
        media_type: 'IMAGE',
        file_url: `/uploads/${fileName}`,
        file_path: fileName,
        mime_type: file.mimetype,
        file_size: buffer.length,
        object_status: 'AVAILABLE',
        privacy: 'PRIVATE',
      },
    });
  }

  /**
   * Find or create the branding row, then set a single field.
   * Mirrors Branding::createBrand($agency) lazy-init from gateway.
   */
  private async setBrandingField(
    brandableType: BrandableType,
    brandableId: bigint,
    field: string,
    value: bigint | null,
  ): Promise<void> {
    const brandable_type =
      brandableType === 'AGENCY'
        ? 'App\\Models\\Agency'
        : 'App\\Models\\Workspace';

    let branding = await this.prisma.brandings.findFirst({
      where: { brandable_id: brandableId, brandable_type },
    });

    if (!branding) {
      branding = await this.prisma.brandings.create({
        data: {
          brandable_id: brandableId,
          brandable_type,
          color: '#0a7a22',
        },
      });
    }

    await this.prisma.brandings.update({
      where: { id: branding.id },
      data: { [field]: value } as any,
    });
  }
}
