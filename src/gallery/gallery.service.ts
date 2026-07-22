// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as path from 'path';
import * as crypto from 'crypto';
import * as sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import {
  GalleryValidationError,
  MAX_FILES_PER_UPLOAD,
  SIZE_CAPS_MB,
  validateBatch,
} from './gallery.validation';

/**
 * GalleryService — replyagent parity for media library on S3.
 *
 * Backend mirrors `GalleryController.php` + `GalleryHelper.php`:
 *  - Single-shot multipart upload (max 10 files, per-type size caps, ext whitelist).
 *  - S3 key pattern: gallery/w{workspaceId}/{objectId}{.ext}; thumbnails under
 *    thumbs/w{workspaceId}/{objectId}.jpg.
 *  - Listings return all workspace folders + paginated files inside the
 *    current parent (matches replyagent's nav model).
 *  - Soft delete + async S3 cleanup via event emitter (folders wipe by
 *    prefix). ACCESS_DENIED is structured so the UI can show a specific
 *    toast.
 *  - Hourly cron purges items whose `expiry` just passed (mirrors
 *    `DeleteExpiredMediaItems`).
 */
@Injectable()
export class GalleryService {
  private readonly logger = new Logger(GalleryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly events: EventEmitter2,
  ) {}

  /** `time()_randomHex` — replyagent `GalleryHelper::generateId` parity. */
  private generateObjectId(): string {
    return (
      Math.floor(Date.now() / 1000) +
      '_' +
      crypto.randomBytes(8).toString('hex')
    );
  }

  // ─── Upload ──────────────────────────────────────────────────────────

  async uploadFiles(
    files: Express.Multer.File[],
    parentId: string | null,
    workspaceId: bigint,
    userId: bigint,
    modelableId: bigint,
    modelableType: string,
  ) {
    // 1) Validate — per-file + batch caps. Surface a 422-style structured
    //    error so the frontend can show the exact reason.
    let validated;
    try {
      validated = validateBatch(files ?? []);
    } catch (e: any) {
      if (e instanceof GalleryValidationError) {
        throw new BadRequestException({
          success: false,
          code: e.code,
          message: e.message,
        });
      }
      throw e;
    }

    // 2) Resolve folder if parent_id provided.
    let folder = null;
    if (parentId && parentId !== 'null') {
      folder = await this.prisma.media_gallery.findFirst({
        where: {
          OR: [
            { object_id: parentId },
            { id: /^\d+$/.test(parentId) ? BigInt(parentId) : -1n },
          ],
          workspace_id: workspaceId,
          media_type: 'FOLDER',
          object_status: 'AVAILABLE',
        },
      });
      if (!folder) {
        throw new BadRequestException({
          success: false,
          code: 'INVALID_FOLDER',
          message: 'Target folder not found',
        });
      }
    }

    // 3) Upload each file. If any one fails mid-batch, roll back the ones
    //    that already landed in S3 so the caller never sees orphan rows.
    const uploadedMedia: any[] = [];
    const s3KeysToRollback: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const meta = validated[i];
        const objectId = this.generateObjectId();
        const extension = path.extname(file.originalname).replace(/^\./, '') || meta.extension;

        // S3 key: inside the folder's prefix if one is set, else the
        // workspace root. Replyagent's `getUserPath()` parity.
        const dirPrefix = folder?.file_path
          ? folder.file_path
          : S3Service.getWorkspacePath(workspaceId.toString());
        const filePath = `${dirPrefix}${objectId}.${extension}`;

        const uploaded = await this.s3.upload(
          file.buffer,
          filePath,
          file.mimetype,
        );
        if (!uploaded) {
          const detail = this.s3.lastError ? ` — ${this.s3.lastError}` : '';
          throw new BadRequestException({
            success: false,
            code: 'S3_UPLOAD_FAILED',
            message: `Failed to upload ${file.originalname} to storage${detail}`,
          });
        }
        s3KeysToRollback.push(filePath);

        // Read authoritative size from S3 (replyagent reads
        // `Storage::disk('s3')->size($file_path)` after upload — survives
        // any multer-side truncation).
        const sizeFromS3 = await this.s3.getSize(filePath);
        const finalSize = sizeFromS3 || file.size;

        // Image thumbnail (jpg/jpeg/png). Other types get nothing inline —
        // video thumbnails would need FFmpeg, out of scope here.
        let thumb200: string | null = null;
        let thumb200Path: string | null = null;
        if (meta.kind === 'IMAGE' && ['jpg', 'jpeg', 'png'].includes(extension.toLowerCase())) {
          try {
            const thumbBuf = await sharp(file.buffer)
              .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 75 })
              .toBuffer();
            const thumbKey =
              S3Service.getWorkspaceThumbsPath(workspaceId.toString()) +
              `${objectId}.jpg`;
            const thumbUp = await this.s3.upload(thumbBuf, thumbKey, 'image/jpeg');
            if (thumbUp) {
              thumb200 = thumbKey;
              thumb200Path = thumbKey;
              s3KeysToRollback.push(thumbKey);
            }
          } catch (err) {
            // Thumbnail failure is non-fatal — replyagent skips silently too.
            this.logger.warn(
              `Thumbnail generation failed for ${file.originalname}: ${err}`,
            );
          }
        }

        // Defensive column-length truncation (schema: mime_type 50,
        // extension 10, object_name 100, file_path 500).
        const media = await this.prisma.media_gallery.create({
          data: {
            workspace_id: workspaceId,
            user_id: userId,
            modelable_id: modelableId,
            modelable_type: modelableType,
            object_type: 'WORKSPACE',
            parent_id: folder ? folder.id : null,
            object_id: objectId,
            object_name: file.originalname.slice(0, 100),
            media_type: meta.kind,
            file_url: filePath.slice(0, 500),
            file_path: filePath.slice(0, 500),
            thumb_200: thumb200,
            thumb_200_path: thumb200Path,
            mime_type: file.mimetype ? file.mimetype.slice(0, 50) : null,
            extension: extension.slice(0, 10),
            file_size: finalSize,
            object_status: 'AVAILABLE',
            privacy: 'PRIVATE',
          },
        });
        uploadedMedia.push(media);
      }
    } catch (err) {
      // Roll back any S3 objects we created before the failure so we don't
      // leak storage. DB rows we already inserted also get reverted.
      for (const key of s3KeysToRollback) {
        await this.s3.delete(key).catch(() => undefined);
      }
      if (uploadedMedia.length > 0) {
        await this.prisma.media_gallery
          .deleteMany({
            where: { id: { in: uploadedMedia.map((m) => m.id) } },
          })
          .catch(() => undefined);
      }
      throw err;
    }

    return {
      success: true,
      message: 'Files uploaded successfully',
      folder,
      // Replyagent returns the array under `data`; keep it under both keys
      // so existing callers don't break.
      data: uploadedMedia,
      media: uploadedMedia,
    };
  }

  // ─── Folder create ───────────────────────────────────────────────────

  async createFolder(
    name: string,
    workspaceId: bigint,
    userId: bigint,
    modelableId: bigint,
    modelableType: string,
    _parentId?: string,
  ) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException({
        success: false,
        code: 'NAME_REQUIRED',
        message: 'Folder name is required',
      });
    }
    if (trimmed.length > 255) {
      throw new BadRequestException({
        success: false,
        code: 'NAME_TOO_LONG',
        message: 'Folder name must be 255 characters or fewer',
      });
    }

    // Replyagent's `createFolder` deliberately ignores parent_id — folders
    // are root-only. Mirror that here so the UI navigation model stays
    // consistent (top-level dropdown of all workspace folders).
    const objectId = this.generateObjectId();
    const folderPath = `${S3Service.getWorkspacePath(workspaceId.toString())}${objectId}/`;

    const folder = await this.prisma.media_gallery.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        modelable_id: modelableId,
        modelable_type: modelableType,
        object_type: 'WORKSPACE',
        parent_id: null,
        object_id: objectId,
        object_name: trimmed.slice(0, 100),
        media_type: 'FOLDER',
        // Store the S3 prefix so cascading delete can wipe it.
        file_path: folderPath,
        object_status: 'AVAILABLE',
        privacy: 'PRIVATE',
      },
    });

    return {
      success: true,
      data: folder,
      message: 'Folder created successfully',
    };
  }

  // ─── Listings ────────────────────────────────────────────────────────

  async getMediaListings(
    workspaceId: bigint,
    userId: bigint,
    roleSlug: string,
    query: any,
  ) {
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '29');

    // Resolve current parent if the URL has ?object_id=
    let parentId: bigint | null = null;
    if (query.object_id) {
      const parentRecord = await this.prisma.media_gallery.findFirst({
        where: {
          OR: [
            { object_id: query.object_id },
            { id: /^\d+$/.test(query.object_id) ? BigInt(query.object_id) : -1n },
          ],
          workspace_id: workspaceId,
        },
      });
      parentId = parentRecord?.id ?? null;
    }

    // Role visibility — owners see every workspace member's files;
    // non-owners only see their own (replyagent parity).
    const isOwner = roleSlug === 'owner';
    let memberIds: bigint[] = [userId];
    if (isOwner) {
      const members = await this.prisma.workspace_members.findMany({
        where: { workspace_id: workspaceId },
        select: { user_id: true },
      });
      memberIds = members.map((m) => m.user_id);
    }

    // Replyagent's folder dropdown shows ALL workspace folders regardless
    // of which one you're currently inside — that's how you jump sideways.
    // So this query intentionally drops the parent_id constraint.
    const folders = await this.prisma.media_gallery.findMany({
      where: {
        workspace_id: workspaceId,
        user_id: { in: memberIds },
        media_type: 'FOLDER',
        object_status: 'AVAILABLE',
      },
      orderBy: { created_at: 'desc' },
    });

    // `?media_type=IMAGE|VIDEO|FILE|AUDIO` narrows the listing to one kind.
    // replyagent's gallery modal passes this whenever it is opened as a picker
    // — a WhatsApp template with an IMAGE header must not be able to select a
    // PDF. Omitted (or ALL) keeps the normal browse-everything behaviour.
    const requestedType = String(query?.media_type ?? '').trim().toUpperCase();
    const typeFilter =
      requestedType && requestedType !== 'ALL' && requestedType !== 'FOLDER'
        ? requestedType
        : null;

    const filesWhere: any = {
      workspace_id: workspaceId,
      user_id: { in: memberIds },
      object_status: 'AVAILABLE',
      media_type: typeFilter ? typeFilter : { not: 'FOLDER' },
      parent_id: parentId, // null at root, set when inside a folder
    };

    const skip = (page - 1) * limit;
    const [files, totalFiles] = await Promise.all([
      this.prisma.media_gallery.findMany({
        where: filesWhere,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.media_gallery.count({ where: filesWhere }),
    ]);

    // Replace stored S3 keys in file_url / thumb_200 with 1h signed URLs so
    // the bucket stays private.
    const filesWithSignedUrls = await Promise.all(
      files.map(async (f) => {
        const patch: any = { ...f };
        if (f.file_path && f.media_type !== 'FOLDER') {
          const signed = await this.s3.getSignedUrl(f.file_path, 3600);
          if (signed) patch.file_url = signed;
        }
        if (f.thumb_200_path) {
          const signedThumb = await this.s3.getSignedUrl(f.thumb_200_path, 3600);
          if (signedThumb) patch.thumb_200 = signedThumb;
        }
        return patch;
      }),
    );

    return {
      folders,
      file_folders: {
        data: filesWithSignedUrls,
        total: totalFiles,
        current_page: page,
        last_page: Math.max(1, Math.ceil(totalFiles / limit)),
        per_page: limit,
      },
    };
  }

  // ─── Rename ──────────────────────────────────────────────────────────

  async renameObject(
    objectId: string,
    newName: string,
    workspaceId: bigint,
    userId: bigint,
  ) {
    const trimmed = (newName ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException({
        success: false,
        code: 'NAME_REQUIRED',
        message: 'Name is required',
      });
    }
    if (trimmed.length > 100) {
      throw new BadRequestException({
        success: false,
        code: 'NAME_TOO_LONG',
        message: 'Name must be 100 characters or fewer',
      });
    }

    const media = await this.prisma.media_gallery.findFirst({
      where: { object_id: objectId, workspace_id: workspaceId },
    });
    if (!media) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'Item not found',
      });
    }
    if (media.user_id !== userId) {
      // Mirrors replyagent's "ACCESS_DENIED" response when a non-owner
      // tries to rename someone else's file.
      throw new ForbiddenException({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'You cannot rename items owned by another agent',
      });
    }

    await this.prisma.media_gallery.update({
      where: { id: media.id },
      data: { object_name: trimmed.slice(0, 100) },
    });
    return { success: true, message: 'Name updated successfully' };
  }

  // ─── Delete (soft + async cleanup) ───────────────────────────────────

  async deleteMedia(objectId: string, workspaceId: bigint, userId: bigint) {
    const media = await this.prisma.media_gallery.findFirst({
      where: { object_id: objectId, workspace_id: workspaceId },
    });
    if (!media) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'Item not found',
      });
    }
    if (media.user_id !== userId) {
      // Owner can technically still delete via a separate workspace-admin
      // path, but matching replyagent we lock per-row to the creator here.
      throw new ForbiddenException({
        success: false,
        code: 'ACCESS_DENIED',
        message: 'You cannot delete items owned by another agent',
      });
    }

    const now = new Date();
    await this.prisma.media_gallery.update({
      where: { id: media.id },
      data: { object_status: 'DELETED', deleted_at: now },
    });

    if (media.media_type === 'FOLDER') {
      // Mark every direct child DELETED too. The async listener will wipe
      // the S3 prefix in one shot.
      await this.prisma.media_gallery.updateMany({
        where: { parent_id: media.id, object_status: 'AVAILABLE' },
        data: { object_status: 'DELETED', deleted_at: now },
      });
    }

    // Hand off the actual S3 cleanup to the async listener so the request
    // returns instantly and we get retries on transient S3 failures.
    this.events.emit('gallery.cleanup', {
      mediaId: media.id.toString(),
      isFolder: media.media_type === 'FOLDER',
      filePath: media.file_path,
    });

    return { success: true, message: 'Deleted successfully' };
  }

  // ─── Download (streamed) ─────────────────────────────────────────────

  async getDownloadStream(objectId: string, workspaceId: bigint) {
    const media = await this.prisma.media_gallery.findFirst({
      where: { object_id: objectId, workspace_id: workspaceId, object_status: 'AVAILABLE' },
    });
    if (!media || !media.file_path) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'File not found',
      });
    }
    const stream = await this.s3.getObjectStream(media.file_path);
    if (!stream) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'File missing from storage',
      });
    }
    return {
      stream,
      filename: media.object_name ?? 'download',
      mimeType: media.mime_type ?? 'application/octet-stream',
    };
  }

  // ─── Async cleanup listener (replyagent's DeleteMedia job parity) ────

  @OnEvent('gallery.cleanup', { async: true, promisify: true })
  async handleCleanup(payload: {
    mediaId: string;
    isFolder: boolean;
    filePath: string | null;
  }) {
    const mediaId = BigInt(payload.mediaId);
    try {
      if (payload.isFolder && payload.filePath) {
        // Folder: wipe every object under the prefix, then nuke child DB
        // rows and the folder row itself.
        await this.s3.deleteDirectory(payload.filePath);
        await this.prisma.media_gallery.updateMany({
          where: { parent_id: mediaId },
          data: {
            file_size: 0,
            file_url: null,
            file_path: null,
            thumb_200: null,
            thumb_200_path: null,
            object_status: 'DELETED',
            deleted_at: new Date(),
          },
        });
        await this.prisma.media_gallery.update({
          where: { id: mediaId },
          data: {
            file_size: 0,
            file_url: null,
            file_path: null,
            object_status: 'DELETED',
            deleted_at: new Date(),
          },
        });
      } else if (payload.filePath) {
        const ok = await this.s3.delete(payload.filePath);
        if (!ok) {
          this.logger.warn(
            `Initial S3 delete failed for media ${payload.mediaId} — leaving DB row marked DELETED for retry sweep`,
          );
          return;
        }
        // Also wipe the thumbnail if one existed.
        const media = await this.prisma.media_gallery.findUnique({
          where: { id: mediaId },
        });
        if (media?.thumb_200_path) {
          await this.s3.delete(media.thumb_200_path).catch(() => undefined);
        }
        await this.prisma.media_gallery.update({
          where: { id: mediaId },
          data: {
            file_size: 0,
            file_url: null,
            file_path: null,
            thumb_200: null,
            thumb_200_path: null,
            object_status: 'DELETED',
            deleted_at: new Date(),
          },
        });
      }
    } catch (e: any) {
      this.logger.error(
        `gallery.cleanup failed for media ${payload.mediaId}: ${e?.message || e}`,
      );
    }
  }

  // ─── Expiry sweep (replyagent's DeleteExpiredMediaItems job parity) ──

  /**
   * Hourly cron — soft-delete + queue cleanup for any media whose `expiry`
   * just passed in the last hour. WhatsApp template media etc. expire on a
   * server-set timestamp; this is how we honour it.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'gallery-expiry-sweep' })
  async sweepExpiredMedia() {
    try {
      const cutoff = new Date();
      const lookback = new Date(cutoff.getTime() - 60 * 60 * 1000);
      const expired = await this.prisma.media_gallery.findMany({
        where: {
          expiry: { gt: lookback, lte: cutoff },
          object_status: 'AVAILABLE',
        },
        select: { id: true, media_type: true, file_path: true },
      });
      for (const m of expired) {
        await this.prisma.media_gallery.update({
          where: { id: m.id },
          data: { object_status: 'DELETED', deleted_at: cutoff },
        });
        this.events.emit('gallery.cleanup', {
          mediaId: m.id.toString(),
          isFolder: m.media_type === 'FOLDER',
          filePath: m.file_path,
        });
      }
      if (expired.length > 0) {
        this.logger.log(
          `gallery-expiry-sweep: queued cleanup for ${expired.length} expired item(s)`,
        );
      }
    } catch (e: any) {
      this.logger.error(`gallery-expiry-sweep failed: ${e?.message || e}`);
    }
  }

  // Expose the validation limits to the controller so the frontend can
  // mirror them without hardcoding (keeps client + server in lockstep).
  static get limits() {
    return {
      max_files_per_upload: MAX_FILES_PER_UPLOAD,
      size_caps_mb: SIZE_CAPS_MB,
    };
  }
}
