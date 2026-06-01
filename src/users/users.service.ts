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
   */
  async getPublicAPIToken(userId: bigint, workspaceId: bigint) {
    // Laravel logic checked the Workspace table for `api_token`
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { api_token: true },
    });

    return { success: true, api_token: user?.api_token || null };
  }

  /**
   * Generate new programmatic API Token for Webhooks / External triggers.
   */
  async createPublicAPIToken(userId: bigint, workspaceId: bigint) {
    const token = crypto.randomBytes(32).toString('hex');

    await this.prisma.workspaces.update({
      where: { id: workspaceId },
      data: {
        /* mapping api token logic */
      },
    });

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
   * Dedicated Change Password Logic
   * Verifies current password before updating to new hashed password
   */
  async changePassword(userId: bigint, data: any) {
    const { currentPassword, newPassword } = data;

    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Current and new password are required');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
    });

    if (!user) throw new NotFoundException('User not found');

    // Verification - Note: In some systems, password might be empty if using SSO / Social Login
    const isMatched = await bcrypt.compare(currentPassword, user.password || '');
    if (!isMatched) {
      throw new BadRequestException('Current password does not match');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.users.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { success: true, message: 'Password updated successfully' };
  }
}
