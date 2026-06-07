import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import * as path from 'path';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /**
   * List users in a workspace. Used by the Contact Profile's Opportunity
   * form to populate the "Assigned to" dropdown. Returns lean rows so the
   * client picker doesn't have to know about modelable / agency plumbing.
   *
   * Resolution: a workspace owner is identified by `modelable_type=Workspace`
   * + `modelable_id=workspaceId`; regular agents are joined through
   * `team_members.workspace_id`. We union both sets and dedupe by id.
   */
  async listWorkspaceUsers(workspaceId: bigint) {
    const [owners, members] = await Promise.all([
      this.prisma.users
        .findMany({
          where: {
            modelable_type: 'App\\Models\\Workspace',
            modelable_id: workspaceId,
          },
          select: {
            id: true,
            first_name: true,
            last_name: true,
            full_name: true,
            email: true,
            gallery_media_id: true,
          },
        })
        .catch(() => [] as any[]),
      (this.prisma as any).team_members
        ?.findMany?.({
          where: { workspace_id: workspaceId },
          select: { user_id: true },
        })
        .catch(() => [] as any[]) ?? [],
    ]);

    const memberIds = (members as any[])
      .map((m) => m.user_id)
      .filter((x): x is bigint => !!x);
    const additionalUsers = memberIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: memberIds } },
          select: {
            id: true,
            first_name: true,
            last_name: true,
            full_name: true,
            email: true,
            gallery_media_id: true,
          },
        })
      : [];

    const byId = new Map<string, any>();
    for (const u of [...owners, ...additionalUsers]) {
      const display =
        u.full_name ||
        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
        u.email;
      byId.set(u.id.toString(), {
        id: u.id.toString(),
        first_name: u.first_name,
        last_name: u.last_name,
        full_name: display,
        name: display,
        email: u.email,
      });
    }
    return { users: Array.from(byId.values()) };
  }

  /**
   * Update User Name, Email, Profile details.
   */
  async updateProfile(userId: bigint, data: any) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const updateData: any = {};
    if (data.name) updateData.full_name = data.name;
    if (data.email) updateData.email = data.email;

    // Handle password change if requested within profile logic
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    const updated = await this.prisma.users.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        full_name: true,
        email: true,
        timezone: true,
        locale: true,
        availability: true,
      },
    });

    return {
      success: true,
      user: updated,
      message: 'Profile updated successfully',
    };
  }

  /**
   * Update Language Preferences.
   */
  async updateLanguage(userId: bigint, language: string) {
    if (!language) throw new BadRequestException('Language is required');

    await this.prisma.users.update({
      where: { id: userId },
      data: { locale: language },
    });

    return { success: true, message: 'Language updated successfully' };
  }

  /**
   * Update Timezone Preferences.
   */
  async updateDateTime(userId: bigint, data: any) {
    const { time_zone, time_format, date_format } = data;

    const updateData: any = {};
    if (time_zone) updateData.timezone = time_zone;
    if (time_format) updateData.time_format = time_format;
    if (date_format) updateData.date_format = date_format;

    await this.prisma.users.update({
      where: { id: userId },
      data: updateData,
    });

    return { success: true, message: 'Date and time settings updated' };
  }

  /**
   * Set agent availability (Online / Offline Toggle).
   */
  async setAvailability(userId: bigint, availability: number) {
    if (typeof availability === 'undefined') {
      throw new BadRequestException('Availability status required');
    }

    const availability_status = availability === 1 ? 'AVAILABLE' : 'OFFLINE';

    await this.prisma.users.update({
      where: { id: userId },
      data: { availability: availability_status },
    });

    return { success: true, is_online: availability_status === 'AVAILABLE' };
  }

  /**
   * Profile Avatar Upload — replyagent parity: avatar persists as a media_gallery row
   * and users.gallery_media_id references it. Accepts a multipart file OR base64 data URL.
   * Returns a 1h signed URL the frontend can render immediately.
   */
  async uploadProfileLogo(
    userId: bigint,
    file: Express.Multer.File | string | any,
    isBase64 = false,
  ) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // 1. Normalise input → { buffer, mime, ext, originalName }
    let buffer: Buffer;
    let mime = 'image/png';
    let ext = 'png';
    let originalName = 'avatar';

    if (isBase64 && typeof file === 'string') {
      const match = file.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!match) throw new BadRequestException('Invalid base64 image');
      mime = match[1];
      buffer = Buffer.from(match[2], 'base64');
      ext = mime.split('/')[1] || 'png';
    } else if (file && typeof file === 'object' && (file as Express.Multer.File).buffer) {
      const f = file as Express.Multer.File;
      buffer = f.buffer;
      mime = f.mimetype || 'image/png';
      originalName = f.originalname || 'avatar';
      ext = (path.extname(originalName).replace(/^\./, '') || mime.split('/')[1] || 'png').toLowerCase();
    } else {
      throw new BadRequestException('No file provided');
    }

    if (!mime.startsWith('image/')) {
      throw new BadRequestException('Avatar must be an image');
    }

    // 2. Resolve scoped path (parity with GalleryHelper::getUserPath in replyagent).
    let folderPath: string;
    if (user.modelable_type === 'App\\Models\\Agency' && user.modelable_id) {
      folderPath = S3Service.getAgencyPath(user.modelable_id.toString(), 'avatars');
    } else if (user.modelable_type === 'App\\Models\\Workspace' && user.modelable_id) {
      folderPath = S3Service.getWorkspacePath(user.modelable_id.toString(), 'avatars');
    } else {
      folderPath = `gallery/users/`;
    }
    const objectId = `${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(8).toString('hex')}`;
    const filePath = `${folderPath}u${userId}_${objectId}.${ext}`;

    // 3. Upload to S3.
    const uploaded = await this.s3.upload(buffer, filePath, mime);
    if (!uploaded) {
      const detail = this.s3.lastError ? ` — ${this.s3.lastError}` : '';
      throw new BadRequestException(`Failed to upload avatar to storage${detail}`);
    }

    // 4. Persist as media_gallery (replyagent stores avatars in gallery).
    const media = await this.prisma.media_gallery.create({
      data: {
        workspace_id: user.modelable_type === 'App\\Models\\Workspace' ? user.modelable_id : null,
        user_id: userId,
        modelable_id: user.modelable_id ?? userId,
        modelable_type: user.modelable_type ?? 'App\\Models\\User',
        object_id: objectId,
        object_name: originalName.slice(0, 100),
        media_type: 'IMAGE',
        file_url: filePath.slice(0, 500),
        file_path: filePath.slice(0, 500),
        mime_type: mime.slice(0, 50),
        extension: ext.slice(0, 10),
        file_size: buffer.length,
        object_status: 'AVAILABLE',
        privacy: 'PRIVATE',
      },
    });

    // 5. Reference on user; best-effort delete the previous avatar file.
    if (user.gallery_media_id && user.gallery_media_id !== media.id) {
      const prev = await this.prisma.media_gallery.findUnique({ where: { id: user.gallery_media_id } });
      if (prev?.file_path) await this.s3.delete(prev.file_path);
    }
    await this.prisma.users.update({
      where: { id: userId },
      data: { gallery_media_id: media.id },
    });

    const signed = (await this.s3.getSignedUrl(filePath, 3600)) || '';
    return {
      success: true,
      logo: signed,
      message: 'Avatar updated successfully',
    };
  }

  /**
   * Remove Profile Avatar.
   */
  async removeProfileLogo(userId: bigint) {
    await this.prisma.users.update({
      where: { id: userId },
      data: { gallery_media_id: null },
    });

    return { success: true, message: 'Avatar removed successfully' };
  }

  /**
   * Get programmatic API Token for Webhooks / External triggers.
   * Mirrors replyagent's `UsersController@getPublicAPIToken`.
   */
  async getPublicAPIToken(userId: bigint, workspaceId: bigint) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { api_token: true },
    });

    return { success: true, api_token: user?.api_token || null };
  }

  /**
   * Generate a new programmatic API token and persist it to
   * `users.api_token`. Mirrors replyagent's `createPublicAPIToken`
   * (which used Sanctum); we store the raw token directly so the
   * `PublicApiGuard` can do a single equality check on inbound
   * `Authorization: Bearer …` requests.
   *
   * Audit-logged as `api_token_regenerated` so a workspace owner can
   * see when a token was rotated and from where.
   */
  async createPublicAPIToken(
    userId: bigint,
    workspaceId: bigint,
    requestIp?: string,
  ) {
    const token = crypto.randomBytes(32).toString('hex');

    await this.prisma.users.update({
      where: { id: userId },
      data: { api_token: token },
    });

    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event: 'api_token_regenerated',
          modelable_type: 'App\\Models\\User',
          modelable_id: userId,
          data: JSON.stringify({ ip: requestIp ?? null }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[createPublicAPIToken] audit log write failed: ${err?.message ?? err}`,
      );
    }

    return { success: true, api_token: token, message: 'API Token generated' };
  }

  /**
   * Get UI Theme preferences from User States.
   */
  async getTheme(userId: bigint) {
    const state = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'THEME' },
    });
    if (!state) return { mode: 'light', primaryColor: '217 91% 60%' };
    try {
      return JSON.parse(state.data);
    } catch (e) {
      return { mode: 'light', primaryColor: '217 91% 60%' };
    }
  }

  /**
   * Update UI Theme preferences in User States.
   */
  async updateTheme(userId: bigint, data: any) {
    const { mode, primaryColor } = data;
    const existing = await this.prisma.user_states.findFirst({
      where: { user_id: userId, type: 'THEME' },
    });

    const themeData = JSON.stringify({ mode, primaryColor });

    if (existing) {
      await this.prisma.user_states.update({
        where: { id: existing.id },
        data: { data: themeData },
      });
    } else {
      await this.prisma.user_states.create({
        data: {
          user_id: userId,
          type: 'THEME',
          data: themeData,
        },
      });
    }

    return { success: true, message: 'Theme updated successfully' };
  }

  /**
   * Dedicated Change Password — mirrors replyagent's
   * `Api\AuthController@changePassword`. Validates server-side (don't trust
   * the client-only rules), checks the current password, rejects reuse of
   * the same password, persists the bcrypt hash, and writes a
   * `password_changed` audit log row with the request IP for compliance.
   *
   * Returns 400 with `{ errors: { field: message } }` on validation failures
   * so the frontend can surface errors per field (matches replyagent's
   * response shape).
   */
  async changePassword(
    userId: bigint,
    data: any,
    requestIp?: string,
  ) {
    // Accept both camelCase (frontend) and snake_case (replyagent parity)
    // so external integrators using the legacy shape keep working.
    const currentPassword: string =
      data?.currentPassword ?? data?.current_password ?? data?.old_password;
    const newPassword: string =
      data?.newPassword ?? data?.new_password;
    const retypePassword: string =
      data?.retypePassword ?? data?.retype_password ?? data?.confirm_password;

    const errors: Record<string, string> = {};
    if (!currentPassword) errors.currentPassword = 'Current password is required';
    if (!newPassword) errors.newPassword = 'New password is required';
    if (!retypePassword)
      errors.retypePassword = 'Retype password is required';

    // Complexity gates — kept in sync with the UI rules so a successful
    // direct API call cannot bypass them.
    if (newPassword) {
      const complaints: string[] = [];
      if (newPassword.length < 8) complaints.push('at least 8 characters');
      if (!/[A-Z]/.test(newPassword)) complaints.push('one uppercase letter');
      if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPassword))
        complaints.push('one special character');
      if (!/\d/.test(newPassword)) complaints.push('one number');
      if (complaints.length) {
        errors.newPassword = `Password must contain ${complaints.join(', ')}`;
      }
    }

    if (newPassword && retypePassword && newPassword !== retypePassword) {
      errors.retypePassword = 'Passwords do not match';
    }

    if (Object.keys(errors).length) {
      throw new BadRequestException({ errors });
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');

    // user.password is nullable for SSO/social-login users — bcrypt.compare
    // against '' returns false safely, so the user just gets a normal
    // "current password is wrong" error.
    const isMatched = await bcrypt.compare(
      currentPassword,
      user.password || '',
    );
    if (!isMatched) {
      throw new BadRequestException({
        errors: { currentPassword: 'Current password is incorrect' },
      });
    }

    // Block reusing the exact same password. (Without password_history this
    // is the best we can do — replyagent does no reuse check at all, so
    // we're already ahead of parity here.)
    if (user.password) {
      const sameAsOld = await bcrypt.compare(newPassword, user.password);
      if (sameAsOld) {
        throw new BadRequestException({
          errors: { newPassword: 'New password must differ from the current one' },
        });
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.users.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    // Replyagent writes an audit log entry on password change with the
    // request IP for compliance. We mirror that shape exactly — Laravel-style
    // modelable_type so existing log readers (admin dashboards, replyagent
    // legacy tooling) recognise the row.
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: user.active_workspace_id ?? BigInt(0),
          user_id: userId,
          event: 'password_changed',
          modelable_type: 'App\\Models\\User',
          modelable_id: userId,
          data: JSON.stringify({ ip: requestIp ?? null }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err) {
      // Audit-log failure must never block the user from changing their
      // password — surface the failure to logs and continue.
      this.logger.warn(
        `[changePassword] audit_logs write failed: ${(err as Error)?.message ?? err}`,
      );
    }

    return {
      success: true,
      message: 'Password updated successfully',
      code: 'SUCCESS',
    };
  }
}
