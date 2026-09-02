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
import { NodeHttpHandler } from '@smithy/node-http-handler';

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
      // Generous timeout for the rare call that still streams a body
      // through the SDK directly. Measured on this environment: the very
      // first HTTPS connection to S3 in a process's lifetime is slow
      // (2-5s, sometimes more — looks like slow TLS/connection setup, not
      // an app bug), but every subsequent request over a kept-alive
      // connection drops to ~300ms. So — unlike an earlier attempt here —
      // keep-alive is left ON (the SDK's default): disabling it would force
      // every single request to eat that slow cold-start cost instead of
      // paying it once per process.
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 10_000,
        requestTimeout: 60_000,
      }),
      maxAttempts: 3,
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

  // App-wide signed-URL cache, keyed by s3Key. Every caller (the inbox list
  // endpoint, the realtime socket path when a new WhatsApp message lands,
  // etc.) MUST go through this instead of calling getSignedUrl() directly
  // for anything the frontend renders as a persistent <img>/<audio>/<video>
  // src — two independent signSigV4 calls for the same object produce two
  // different (both valid) query strings, and when a live socket-delivered
  // URL is later swapped for a freshly re-signed one from a poll, the
  // browser sees the src attribute change and aborts/restarts whatever was
  // mid-playback. Sharing one cached signature keeps the URL byte-identical
  // across every code path for as long as it's cached.
  private readonly signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

  async getCachedSignedUrl(filePath: string, ttlSeconds = 604800): Promise<string | null> {
    const now = Date.now();
    const cached = this.signedUrlCache.get(filePath);
    if (cached && cached.expiresAt > now + 3600_000) return cached.url; // >1hr left → reuse
    const url = await this.getSignedUrl(filePath, ttlSeconds);
    if (url) this.signedUrlCache.set(filePath, { url, expiresAt: now + ttlSeconds * 1000 });
    return url;
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
