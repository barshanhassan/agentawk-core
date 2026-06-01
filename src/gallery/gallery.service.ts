// @ts-nocheck
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as path from 'path';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import { S3Service } from '../s3/s3.service';

@Injectable()
export class GalleryService {
  private readonly logger = new Logger(GalleryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly s3: S3Service,
  ) {}

  private generateObjectId(): string {
    return (
      Math.floor(Date.now() / 1000) +
      '_' +
      crypto.randomBytes(8).toString('hex')
    );
  }

  /**
   * Upload an array of files.
   */
  async uploadFiles(
    files: Express.Multer.File[],
    parentId: string | null,
    workspaceId: bigint,
    userId: bigint,
    modelableId: bigint,
    modelableType: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('Please select any file');
    }

    let folder = null;
    if (parentId && parentId !== 'null') {
      folder = await this.prisma.media_gallery.findFirst({
        where: {
          OR: [
            { object_id: parentId },
            { id: /^\d+$/.test(parentId) ? BigInt(parentId) : -1n },
          ],
          workspace_id: workspaceId,
        },
      });
    }

    // Processing each file
    const uploadedMedia = [];
    for (const file of files) {
      const objectId = this.generateObjectId();
      const extension = path.extname(file.originalname);

      // S3 upload — replyagent parity: gallery/w{workspaceId}/{objectId}{ext}
      const filePath =
        S3Service.getWorkspacePath(workspaceId.toString()) +
        `${objectId}${extension}`;

      const uploaded = await this.s3.upload(
        file.buffer,
        filePath,
        file.mimetype,
      );
      if (!uploaded) {
        // Include the S3 SDK error so the frontend toast surfaces the root cause
        // (e.g. InvalidAccessKeyId, AccessDenied) — easier than scraping Cloud Run logs.
        const detail = this.s3.lastError ? ` — ${this.s3.lastError}` : '';
        throw new BadRequestException(
          `Failed to upload ${file.originalname} to storage${detail}`,
        );
      }
      // file_url stores S3 key; getMediaListings rewrites it to a signed URL on read.
      const fileUrl = filePath;

      const mime = file.mimetype.toLowerCase();
      let mediaType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'FILE' = 'FILE';
      if (mime.startsWith('image/')) mediaType = 'IMAGE';
      else if (mime.startsWith('video/')) mediaType = 'VIDEO';
      else if (mime.startsWith('audio/')) mediaType = 'AUDIO';
      else if (
        mime.includes('pdf') ||
        mime.includes('word') ||
        mime.includes('excel')
      )
        mediaType = 'DOCUMENT';

      // Defensive truncation — schema columns are bounded (mime_type 50, extension 10, object_name 100,
      // file_path 500) and real-world office mimes (xlsx/docx/pptx) exceed 70 chars.
      const media = await this.prisma.media_gallery.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          modelable_id: modelableId,
          modelable_type: modelableType,
          parent_id: folder ? folder.id : null,
          object_id: objectId,
          object_name: file.originalname.slice(0, 100),
          media_type: mediaType,
          file_url: fileUrl.slice(0, 500),
          file_path: filePath.slice(0, 500),
          mime_type: file.mimetype ? file.mimetype.slice(0, 50) : null,
          extension: extension ? extension.replace(/^\./, '').slice(0, 10) : null,
          file_size: file.size,
          object_status: 'AVAILABLE',
          privacy: 'PRIVATE',
        },
      });
      uploadedMedia.push(media);
    }

    return {
      success: true,
      message: 'Files uploaded successfully',
      folder,
      media: uploadedMedia,
    };
  }

  /**
   * Create a folder within the workspace's gallery.
   */
  async createFolder(
    name: string,
    workspaceId: bigint,
    userId: bigint,
    modelableId: bigint,
    modelableType: string,
    parentId?: string,
  ) {
    if (!name) throw new BadRequestException('Folder name is required');

    let resolvedParentId = null;
    if (parentId && parentId !== 'null') {
      const parentRecord = await this.prisma.media_gallery.findFirst({
        where: {
          OR: [
            { object_id: parentId },
            { id: /^\d+$/.test(parentId) ? BigInt(parentId) : -1n },
          ],
          workspace_id: workspaceId,
        },
      });
      resolvedParentId = parentRecord?.id || null;
    }

    const folder = await this.prisma.media_gallery.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        modelable_id: modelableId,
        modelable_type: modelableType,
        parent_id: resolvedParentId,
        object_id: this.generateObjectId(),
        object_name: name,
        media_type: 'FOLDER',
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

  /**
   * Get paginated media listings, including folders and files.
   */
  async getMediaListings(
    workspaceId: bigint,
    userId: bigint,
    roleSlug: string,
    query: any,
  ) {
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '29'); // Matches Laravel's paginate(29)

    let parentId = null;
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
      parentId = parentRecord?.id || null;
    }

    const skip = (page - 1) * limit;

    // Role-based visibility
    const isOwner = roleSlug === 'owner';
    let memberIds = [userId];
    if (isOwner) {
      // Stub: If owner, fetch all members' IDs in the workspace to see their files
      const members = await this.prisma.workspace_members.findMany({
        where: { workspace_id: workspaceId },
        select: { user_id: true },
      });
      memberIds = members.map((m) => m.user_id);
    }

    const folders = await this.prisma.media_gallery.findMany({
      where: {
        workspace_id: workspaceId,
        user_id: { in: memberIds },
        media_type: 'FOLDER',
        object_status: 'AVAILABLE',
        parent_id: parentId,
      },
      orderBy: { created_at: 'desc' },
    });

    const filesWhere: any = {
      workspace_id: workspaceId,
      user_id: { in: memberIds },
      object_status: 'AVAILABLE',
      media_type: { not: 'FOLDER' },
    };

    if (parentId) {
      filesWhere.parent_id = parentId;
    } else {
      filesWhere.parent_id = null;
      // Exclude folders from the main files list if we are at root, or handle accordingly.
      // In Laravel, the file listing includes FOLDER type? The Laravel code explicitly queries folders separately, then files separately
      // so we might want to exclude media_type = 'FOLDER' here, depending on how the frontend handles it.
      // Let's stick to the Laravel parity where $query doesn't exclude it, but maybe the frontend filters.
    }

    const [files, totalFiles] = await Promise.all([
      this.prisma.media_gallery.findMany({
        where: filesWhere,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.media_gallery.count({ where: filesWhere }),
    ]);

    // Replace stored S3 key in file_url with a fresh 1h signed URL
    const filesWithSignedUrls = await Promise.all(
      files.map(async (f) => {
        if (f.file_path && f.media_type !== 'FOLDER') {
          const signed = await this.s3.getSignedUrl(f.file_path, 3600);
          if (signed) return { ...f, file_url: signed };
        }
        return f;
      }),
    );

    return {
      folders,
      file_folders: {
        data: filesWithSignedUrls,
        total: totalFiles,
        current_page: page,
        last_page: Math.ceil(totalFiles / limit),
      },
    };
  }

  /**
   * Rename an object (File or Folder).
   */
  async renameObject(
    objectId: string,
    newName: string,
    workspaceId: bigint,
    userId: bigint,
  ) {
    if (!newName) throw new BadRequestException('Name is missing');

    const media = await this.prisma.media_gallery.findFirst({
      where: { object_id: objectId, workspace_id: workspaceId },
    });

    if (!media || media.user_id !== userId) {
      throw new BadRequestException('Invalid request or access denied');
    }

    await this.prisma.media_gallery.update({
      where: { id: media.id },
      data: { object_name: newName },
    });

    return { success: true, message: 'Name updated successfully' };
  }

  /**
   * Delete an object.
   */
  async deleteMedia(objectId: string, workspaceId: bigint, userId: bigint) {
    const media = await this.prisma.media_gallery.findFirst({
      where: { object_id: objectId, workspace_id: workspaceId },
    });

    if (!media || media.user_id !== userId) {
      throw new BadRequestException('Invalid request or access denied');
    }

    // Best-effort S3 cleanup before DB delete (folders have no file_path)
    if (media.file_path && media.media_type !== 'FOLDER') {
      await this.s3.delete(media.file_path);
    }

    // Perform hard delete from database
    await this.prisma.media_gallery.delete({
      where: { id: media.id },
    });

    return { success: true, message: 'Deleted successfully' };
  }
}
