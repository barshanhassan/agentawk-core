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

  // ─── Replyagent parity: contact profile modal endpoints ─────────────

  /** POST /api/contacts/:id/change-status { action } */
  @Post(':id/change-status')
  async changeStatus(
    @Param('id') id: string,
    @Body('action') action: string,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.changeContactStatus(workspaceId, BigInt(id), action);
  }

  /** DELETE /api/contacts/:id/field — body: { field, type } */
  @Post(':id/remove-field')
  async removeField(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.removeField(
      workspaceId,
      BigInt(id),
      body.field ?? body,
      body.type ?? 'contact',
    );
  }

  /** POST /api/contacts/:id/primary — body: { field_id, field_type, mark_primary } */
  @Post(':id/primary')
  async setPrimary(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.setPrimary(
      workspaceId,
      BigInt(id),
      BigInt(body.field_id),
      String(body.field_type ?? 'mobile').toLowerCase() === 'email'
        ? 'email'
        : 'mobile',
      !!body.mark_primary,
    );
  }

  /** POST /api/contacts/:id/unsubscribe — body: { optin_id } */
  @Post(':id/unsubscribe')
  async unsubscribe(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.unsubscribe(
      workspaceId,
      BigInt(id),
      BigInt(body.optin_id),
    );
  }

  /** POST /api/contacts/:id/optin — body: { channel } */
  @Post(':id/optin')
  async optin(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.optin(workspaceId, BigInt(id), body);
  }

  /** GET /api/contacts/:id/merge-preview — destination contact full data */
  @Get(':id/merge-preview')
  async mergePreview(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getContactForMerge(workspaceId, BigInt(id));
  }

  /** POST /api/contacts/search/simple — body: { search, type } */
  @Post('search/simple')
  async simpleSearch(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.simpleSearch(
      workspaceId,
      String(body.search ?? ''),
      String(body.type ?? 'full_name'),
    );
  }

  /** POST /api/contacts/search-destination — body: { current_contact_id, key } */
  @Post('search-destination')
  async searchDestination(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.searchDestinationContacts(
      workspaceId,
      BigInt(body.current_contact_id),
      String(body.key ?? ''),
    );
  }

  /** POST /api/contacts/merge — body: { current_contact, destination_contact } */
  @Post('merge')
  async merge(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.mergeContacts(
      workspaceId,
      BigInt(body.current_contact),
      BigInt(body.destination_contact),
    );
  }

  /** POST /api/contacts/:id/change-company — body: { company_id } */
  @Post(':id/change-company')
  async changeCompany(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.changeCompany(
      workspaceId,
      BigInt(id),
      body.company_id ? BigInt(body.company_id) : null,
    );
  }

  /** GET /api/contacts/:id/download-conversation — plain-text transcript */
  @Get(':id/download-conversation')
  async downloadConversation(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const text = await this.service.downloadConversation(
      workspaceId,
      BigInt(id),
    );
    return { text, filename: `contact-${id}-conversation.txt` };
  }
}
