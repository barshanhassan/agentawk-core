import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  UseGuards,
  Request,
  Response,
  Param,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { GalleryService } from './gallery.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('gallery')
export class GalleryController {
  constructor(private readonly service: GalleryService) {}

  /**
   * Multipart upload — capped at 10 files (matches MAX_FILES_PER_UPLOAD) so
   * Multer rejects oversize batches before they hit our validation layer.
   */
  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadFile(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || req.user.sub || 1);
    const modelableId = BigInt(req.user.modelable_id || 1);
    const modelableType = req.user.modelable_type || 'App\\Models\\Agency';
    return this.service.uploadFiles(
      files,
      body.parent_id,
      workspaceId,
      userId,
      modelableId,
      modelableType,
    );
  }

  @Post('folder')
  async createFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || req.user.sub || 1);
    const modelableId = BigInt(req.user.modelable_id || 1);
    const modelableType = req.user.modelable_type || 'App\\Models\\Agency';
    return this.service.createFolder(
      body.name,
      workspaceId,
      userId,
      modelableId,
      modelableType,
      body.parent_id,
    );
  }

  @Get('listings')
  async getMediaListings(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    const roleSlug = req.user.role || 'member';
    return this.service.getMediaListings(workspaceId, userId, roleSlug, query);
  }

  /** Static limits so the frontend can mirror them (size caps + batch cap)
   *  without hardcoding. Public-via-JWT — every workspace gets the same caps. */
  @Get('limits')
  async getLimits() {
    return {
      success: true,
      limits: GalleryService.limits,
    };
  }

  @Patch('rename/:id')
  async renameObject(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.renameObject(id, body.object_name, workspaceId, userId);
  }

  @Delete('media/:id')
  async deleteMedia(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.deleteMedia(id, workspaceId, userId);
  }

  /**
   * Server-mediated download — streams the object from S3 with a forced
   * Content-Disposition: attachment header so the browser actually saves
   * the file. Replyagent's `/gallery/download/{object_id}` parity.
   */
  @Get('download/:id')
  async download(
    @Param('id') id: string,
    @Request() req: any,
    @Response() res: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const { stream, filename, mimeType } = await this.service.getDownloadStream(
      id,
      workspaceId,
    );
    // Quote the filename so spaces/special chars survive the header round-trip.
    const safeName = (filename || 'download').replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"`,
    );
    stream.pipe(res);
  }
}
