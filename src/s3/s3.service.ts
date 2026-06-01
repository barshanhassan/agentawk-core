import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3Service — replyagent S3Helper + GalleryHelper parity for NestJS.
 *
 * - Bucket is private; all browser-facing URLs go through getSignedUrl().
 * - Path conventions mirror gateway: gallery/a{agencyId}/, gallery/w{workspaceId}/, thumbs/...
 * - All uploads force AES256 server-side encryption (bucket policy requires it).
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const region = this.config.get<string>('AWS_REGION') || 'us-east-1';
    const accessKeyId = this.config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('AWS_SECRET_ACCESS_KEY');
    this.bucket = this.config.get<string>('AWS_BUCKET') as string;

    if (!accessKeyId || !secretAccessKey || !this.bucket) {
      this.logger.warn(
        'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_BUCKET missing in env — S3 uploads will fail.',
      );
    }

    this.client = new S3Client({
      region,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }

  // ──────────────────────────── Core operations ────────────────────────────

  /** Upload a buffer/string to S3 at filePath. Returns the S3 key on success, null on failure. */
  async upload(
    content: Buffer | Uint8Array | string,
    filePath: string,
    contentType?: string,
  ): Promise<string | null> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: filePath,
          Body: content,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
      return filePath;
    } catch (e: any) {
      this.logger.error(`upload failed (${filePath}): ${e?.message || e}`);
      return null;
    }
  }

  /** Generate a signed URL for downloading/displaying a private object. Default 1h expiry. */
  async getSignedUrl(filePath: string, expiresIn = 3600): Promise<string | null> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: filePath }),
        { expiresIn },
      );
    } catch (e: any) {
      this.logger.error(`getSignedUrl failed (${filePath}): ${e?.message || e}`);
      return null;
    }
  }

  /** Generate a signed URL for browser to upload directly via PUT. Default 1h expiry. */
  async getUploadUrl(
    filePath: string,
    contentType?: string,
    expiresIn = 3600,
  ): Promise<string | null> {
    try {
      return await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: filePath,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
        { expiresIn },
      );
    } catch (e: any) {
      this.logger.error(`getUploadUrl failed (${filePath}): ${e?.message || e}`);
      return null;
    }
  }

  /** Delete a file. Returns true on success. */
  async delete(filePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: filePath }),
      );
      return true;
    } catch (e: any) {
      this.logger.error(`delete failed (${filePath}): ${e?.message || e}`);
      return false;
    }
  }

  /** Check if a file exists. */
  async exists(filePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: filePath }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Get a file's size in bytes. Returns 0 if not found. */
  async getSize(filePath: string): Promise<number> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: filePath }),
      );
      return out.ContentLength || 0;
    } catch {
      return 0;
    }
  }

  /** List all keys under a prefix. Useful for bulk-delete (e.g. workspace deletion). */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        out.Contents?.forEach((o) => o.Key && keys.push(o.Key));
        continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (e: any) {
      this.logger.error(`listKeys failed (${prefix}): ${e?.message || e}`);
    }
    return keys;
  }

  // ──────────────────────────── Path helpers ────────────────────────────
  // Mirror gateway/app/Helper/GalleryHelper.php (lines 46-61)

  /** gallery/a{agencyId}/[subFolder/] */
  static getAgencyPath(agencyId: number | string, subFolder?: string): string {
    let path = `gallery/a${agencyId}/`;
    if (subFolder) path += `${subFolder}/`;
    return path;
  }

  /** gallery/w{workspaceId}/[subFolder/] */
  static getWorkspacePath(workspaceId: number | string, subFolder?: string): string {
    let path = `gallery/w${workspaceId}/`;
    if (subFolder) path += `${subFolder}/`;
    return path;
  }

  /** thumbs/a{agencyId}/[subFolder/] */
  static getAgencyThumbsPath(agencyId: number | string, subFolder?: string): string {
    let path = `thumbs/a${agencyId}/`;
    if (subFolder) path += `${subFolder}/`;
    return path;
  }

  /** thumbs/w{workspaceId}/[subFolder/] */
  static getWorkspaceThumbsPath(workspaceId: number | string, subFolder?: string): string {
    let path = `thumbs/w${workspaceId}/`;
    if (subFolder) path += `${subFolder}/`;
    return path;
  }

  /** Generate a unique file identifier (replyagent GalleryHelper::generateId parity). */
  static generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
