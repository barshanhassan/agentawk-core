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
import { ContactsService } from './contacts.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly service: ContactsService) {}

  @Get()
  async getContacts(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getContacts(workspaceId, query);
  }

  @Get(':id')
  async getContact(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getContact(workspaceId, BigInt(id));
  }

  @Post()
  async addNewContact(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.addContact(workspaceId, body);
  }

  @Patch(':id')
  async updateContactData(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateContactData(workspaceId, BigInt(id), body);
  }

  @Post(':id/pause-automations')
  async pauseAutomations(
    @Param('id') id: string,
    @Body('minutes') minutes: number,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.pauseAutomations(
      workspaceId,
      BigInt(id),
      minutes || 60,
    );
  }

  @Delete(':id')
  async deleteContact(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteContact(workspaceId, BigInt(id));
  }

  /**
   * Bulk apply tags. Body: { contact_ids: string[], tag_ids: string[] }
   */
  @Post('bulk/tags/apply')
  async bulkApplyTags(@Request() req: any, @Body() body: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.applyTagsBulk(
      workspaceId,
      (body.contact_ids ?? []).map((x: string) => BigInt(x)),
      (body.tag_ids ?? []).map((x: string) => BigInt(x)),
    );
  }

  /**
   * Bulk remove tags. Body: { contact_ids: string[], tag_ids: string[] }
   */
  @Post('bulk/tags/remove')
  async bulkRemoveTags(@Request() req: any, @Body() body: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.removeTagsBulk(
      workspaceId,
      (body.contact_ids ?? []).map((x: string) => BigInt(x)),
      (body.tag_ids ?? []).map((x: string) => BigInt(x)),
    );
  }

  /**
   * CSV export. Returns the raw CSV as a string in JSON response so the
   * frontend can offer it as a download — keeps the API uniform. If you'd
   * prefer a true download stream, switch to res.attachment + res.send().
   */
  @Get('export/csv')
  async exportCsv(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const csv = await this.service.exportCsv(workspaceId);
    return { csv, filename: `contacts-${workspaceId}.csv` };
  }

  /**
   * CSV import. Body: { csv: string } (the raw CSV text). Returns counts.
   */
  @Post('import/csv')
  async importCsv(@Request() req: any, @Body() body: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.service.importCsv(workspaceId, userId, body.csv ?? '');
  }
}
