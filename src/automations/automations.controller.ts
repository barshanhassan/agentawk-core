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
import { AutomationsService } from './automations.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('automations')
export class AutomationsController {
  constructor(private readonly service: AutomationsService) {}

  // Helpers to read auth context off the JWT-decoded request user
  private getWorkspaceId(req: any): bigint {
    return BigInt(req.user?.workspace_id || 1);
  }
  private getUserId(req: any): bigint {
    return BigInt(req.user?.id || req.user?.user_id || 0);
  }

  // ─── Automations ───────────────────────────────────────────────────

  @Get()
  async getAutomations(@Query() query: any, @Request() req: any) {
    return this.service.getAutomations(this.getWorkspaceId(req), query);
  }

  @Get(':id')
  async getAutomation(
    @Param('id') id: string,
    @Query('mode') mode: string,
    @Request() req: any,
  ) {
    return this.service.getAutomation(
      this.getWorkspaceId(req),
      BigInt(id),
      mode || 'draft',
    );
  }

  @Post()
  async createAutomation(@Body() body: any, @Request() req: any) {
    return this.service.createAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      body,
    );
  }

  @Patch(':id')
  async updateAutomation(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.updateAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(id),
      body,
    );
  }

  @Post(':id/duplicate')
  async duplicateAutomation(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.duplicateAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(id),
      body || {},
    );
  }

  @Post(':id/activate')
  async activateAutomation(@Param('id') id: string, @Request() req: any) {
    return this.service.activateAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(id),
    );
  }

  @Post(':id/unpublish')
  async unPublishAutomation(@Param('id') id: string, @Request() req: any) {
    return this.service.unPublishAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(id),
    );
  }

  @Post(':id/publish')
  async publishAutomation(@Param('id') id: string, @Request() req: any) {
    return this.service.publishAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(id),
    );
  }

  @Delete(':id')
  async deleteAutomation(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteAutomation(this.getWorkspaceId(req), BigInt(id));
  }

  // ─── Step Management ───────────────────────────────────────────────

  @Post('version/:versionId/step')
  async createStep(@Param('versionId') versionId: string, @Body() body: any) {
    return this.service.createStep(BigInt(versionId), body);
  }

  @Patch('step/:stepId')
  async updateStep(@Param('stepId') stepId: string, @Body() body: any) {
    return this.service.updateStep(BigInt(stepId), body);
  }

  @Delete('step/:stepId')
  async deleteStep(@Param('stepId') stepId: string) {
    return this.service.deleteStep(BigInt(stepId));
  }

  // ─── Folder Management ─────────────────────────────────────────────
  // Mirrors replyagent's /automations/folder/* routes

  @Get('folder/list')
  async getFolders(@Request() req: any) {
    return this.service.getFolders(this.getWorkspaceId(req));
  }

  @Post('folder/create')
  async createFolder(@Body() body: any, @Request() req: any) {
    return this.service.createOrUpdateFolder(this.getWorkspaceId(req), body);
  }

  @Post('folder/change')
  async changeFolder(@Body() body: any, @Request() req: any) {
    return this.service.changeFolder(
      this.getWorkspaceId(req),
      this.getUserId(req),
      body,
    );
  }

  @Delete('folder/delete/:folderId')
  async deleteFolder(@Param('folderId') folderId: string, @Request() req: any) {
    return this.service.deleteFolder(this.getWorkspaceId(req), BigInt(folderId));
  }

  // ─── Connections (AutomationFlow) ─────────────────────────────────

  @Post('version/:versionId/connection')
  async saveConnection(@Param('versionId') versionId: string, @Body() body: any) {
    return this.service.saveConnection(BigInt(versionId), body);
  }

  @Delete('version/:versionId/connection/:flowId')
  async deleteConnection(
    @Param('versionId') versionId: string,
    @Param('flowId') flowId: string,
  ) {
    return this.service.deleteConnection(BigInt(versionId), BigInt(flowId));
  }

  @Get(':id/connections')
  async getAutomationConnections(@Param('id') id: string, @Request() req: any) {
    return this.service.getAutomationConnections(
      this.getWorkspaceId(req),
      BigInt(id),
    );
  }

  // ─── Step Activities ──────────────────────────────────────────────

  @Post('activity')
  async createStepActivity(@Body() body: any) {
    return this.service.createStepActivity(body);
  }

  @Post('step/:stepId/activities')
  async createStepActivities(
    @Param('stepId') stepId: string,
    @Body() body: any,
  ) {
    return this.service.createStepActivities(BigInt(stepId), body?.activities || []);
  }

  @Patch('activity/:activityId')
  async updateStepActivity(
    @Param('activityId') activityId: string,
    @Body() body: any,
  ) {
    return this.service.updateStepActivity(BigInt(activityId), body);
  }

  @Delete('activity/:activityId')
  async deleteActivity(
    @Param('activityId') activityId: string,
    @Query('reorder') reorder?: string,
  ) {
    // replyagent parity: ?reorder=1 (or truthy) → renumber surviving siblings 1..N
    return this.service.deleteActivity(BigInt(activityId), !!reorder);
  }

  @Delete('step/:stepId/activities')
  async deleteStepActivities(@Param('stepId') stepId: string) {
    return this.service.deleteStepActivities(BigInt(stepId));
  }

  @Post('activity/order')
  async saveActivitiesOrder(@Body() body: any) {
    return this.service.saveActivitiesOrder(body?.activities || []);
  }

  @Get('activity/restore/:activityId')
  async restoreActivity(@Param('activityId') activityId: string) {
    return this.service.restoreActivity(BigInt(activityId));
  }

  // ─── Multi-Step Operations ────────────────────────────────────────

  @Post('steps/delete')
  async deleteSteps(@Body() body: any) {
    return this.service.deleteSteps(body?.steps || []);
  }

  @Patch('steps/restore')
  async restoreSteps(@Body() body: any) {
    return this.service.restoreSteps(body?.steps || [], !!body?.with_activities);
  }

  @Post('version/:versionId/clone-steps')
  async cloneSteps(@Param('versionId') versionId: string, @Body() body: any) {
    return this.service.cloneSteps(BigInt(versionId), body?.steps || []);
  }

  // ─── Quick Replies ────────────────────────────────────────────────

  @Post('step/:stepId/quick-reply')
  async addQuickReply(@Param('stepId') stepId: string, @Body() body: any) {
    return this.service.addQuickReply(BigInt(stepId), body);
  }

  @Patch('step/:stepId/quick-reply/:qrId')
  async updateQuickReply(
    @Param('stepId') stepId: string,
    @Param('qrId') qrId: string,
    @Body() body: any,
  ) {
    return this.service.updateQuickReply(BigInt(stepId), BigInt(qrId), body);
  }

  @Delete('step/:stepId/quick-reply/:qrId')
  async deleteQuickReply(
    @Param('stepId') stepId: string,
    @Param('qrId') qrId: string,
  ) {
    return this.service.deleteQuickReply(BigInt(stepId), BigInt(qrId));
  }

  // ─── Misc ─────────────────────────────────────────────────────────

  @Patch(':id/toggle-feeder')
  async toggleFeeder(@Param('id') id: string, @Request() req: any) {
    return this.service.toggleFeeder(this.getWorkspaceId(req), BigInt(id));
  }

  /**
   * Edit a published automation — creates a fresh draft from the published version
   * so the live flow keeps running while edits happen on the draft.
   * Replyagent parity: this is what the "Edit" button on a published flow triggers.
   */
  @Post(':id/edit-draft')
  async editDraft(@Param('id') id: string, @Request() req: any) {
    return this.service.createDraftFromPublished(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(id),
    );
  }

  /**
   * Clear all in-flight queue/runs/iterations/ai_messages for this automation.
   * Replyagent parity: this is the "Clear Queue" button on a published flow.
   */
  @Post(':id/flush-queue')
  async flushQueue(@Param('id') id: string, @Request() req: any) {
    return this.service.flushAutomationQueue(
      this.getWorkspaceId(req),
      BigInt(id),
    );
  }

  @Post(':id/check-trigger-text/:activityId')
  async checkTriggerText(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.checkTriggerText(
      this.getWorkspaceId(req),
      BigInt(id),
      BigInt(activityId),
      body,
    );
  }

  @Post('activity/:activityId/validate-keywords')
  async validateKeywords(
    @Param('activityId') activityId: string,
    @Body() body: any,
  ) {
    return this.service.validateKeywords(BigInt(activityId), body);
  }
}
