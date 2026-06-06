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
  Param,
} from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Get()
  async getCustomFields(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getCustomFields(workspaceId, query);
  }

  @Post('field')
  async createField(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.createField(workspaceId, userId, body);
  }

  @Delete('field/:slug')
  async deleteCustomField(@Param('slug') slug: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.deleteCustomField(workspaceId, userId, slug);
  }

  @Delete('property/:name')
  async removeProperty(@Param('name') name: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.removeProperty(workspaceId, name);
  }

  @Get('check-availability')
  async checkNameAvailability(
    @Query('system_name') systemName: string,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.checkNameAvailability(workspaceId, systemName);
  }

  /**
   * Static enum / Laravel-class snapshot used by the frontend to populate
   * its dropdowns. Returning it from the API means the schema stays the
   * single source of truth and the UI never goes out of sync.
   */
  @Get('enums')
  getEnums() {
    return this.service.getEnums();
  }

  /**
   * Countries snapshot — drives the CountryPicker for PHONE / COUNTRY /
   * CURRENCY content types. Cached by the frontend (`staleTime: Infinity`).
   */
  @Get('countries')
  getCountries() {
    return this.service.getCountries();
  }

  @Post(':id/toggle-feeder')
  async toggleFeeder(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.toggleFeeder(workspaceId, userId, BigInt(id));
  }

  // ─── Folder Management ──────────────────────────────────────────────

  @Get('folders')
  async getFolders(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getFolders(workspaceId);
  }

  @Post('folder')
  async createFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.createFolder(workspaceId, body);
  }

  @Post('change-folder')
  async changeFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    // Accept both `custom_field_id` (correct) and `tag_id` (legacy copy-paste
    // from the tags controller — kept for one release cycle so any existing
    // client doesn't 500).
    const fieldId = body.custom_field_id ?? body.field_id ?? body.tag_id;
    if (!fieldId) {
      throw new Error('custom_field_id is required');
    }
    return this.service.changeFolder(
      workspaceId,
      BigInt(fieldId),
      body.folder_id ? BigInt(body.folder_id) : null,
    );
  }

  @Delete('folder/:id')
  async deleteFolder(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteFolder(workspaceId, BigInt(id));
  }
}
