import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
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

  /** Last upload error (set by upload() on failure, used by callers to surface root cause). */
  public lastError: string | null = null;

  /** Upload a buffer/string to S3 at filePath. Returns the S3 key on success, null on failure. */
  async upload(
    content: Buffer | Uint8Array | string,
    filePath: string,
    contentType?: string,
  ): Promise<string | null> {
    this.lastError = null;
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
      // Surface the AWS SDK error code + message so the caller can include it in the
      // API response — much easier to debug than digging through Cloud Run logs.
      const code = e?.Code || e?.name || 'UnknownError';
      const msg = e?.message || String(e);
      this.lastError = `[${code}] ${msg}`;
      this.logger.error(`upload failed (${filePath}): ${this.lastError}`);
      return null;
    }
  }

  /**
   * Stream a private object directly (server-mediated download). Use this
   * when you want to force Content-Disposition: attachment headers or hide
   * the bucket URL — the gallery `/download` endpoint relies on this so the
   * browser actually saves the file instead of opening it inline.
   */
  async getObjectStream(filePath: string): Promise<NodeJS.ReadableStream | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: filePath }),
      );
      // AWS SDK v3 returns a Readable on Node — coerce away the union types.
      return (out.Body as unknown as NodeJS.ReadableStream) ?? null;
    } catch (e: any) {
      this.logger.error(`getObjectStream failed (${filePath}): ${e?.message || e}`);
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

  /**
   * Delete every object under a given prefix. Mirrors replyagent's
   * `Storage::disk('s3')->deleteDirectory($path)` — used by folder delete
   * and workspace teardown. Uses ListObjectsV2 + DeleteObjects in batches
   * of 1000 (the S3 API's hard cap per request).
   */
  async deleteDirectory(prefix: string): Promise<{ deleted: number; errored: number }> {
    let deleted = 0;
    let errored = 0;
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
        const keys = (out.Contents ?? [])
          .map((o) => o.Key)
          .filter((k): k is string => !!k);
        if (keys.length > 0) {
          // DeleteObjects accepts up to 1000 keys per call.
          for (let i = 0; i < keys.length; i += 1000) {
            const batch = keys.slice(i, i + 1000);
            const res = await this.client.send(
              new DeleteObjectsCommand({
                Bucket: this.bucket,
                Delete: { Objects: batch.map((k) => ({ Key: k })) },
              }),
            );
            deleted += res.Deleted?.length ?? 0;
            errored += res.Errors?.length ?? 0;
            if (res.Errors?.length) {
              this.logger.error(
                `deleteDirectory partial failure under "${prefix}": ${res.Errors.length} errors`,
              );
            }
          }
        }
        continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (e: any) {
      this.logger.error(
        `deleteDirectory failed (${prefix}): ${e?.message || e}`,
      );
      errored += 1;
    }
    return { deleted, errored };
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
