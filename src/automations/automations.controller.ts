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
import { AutomationIntegrationsService } from './integrations.service';
import { AutomationProcessorService } from './automation-processor.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('automations')
export class AutomationsController {
  constructor(
    private readonly service: AutomationsService,
    private readonly integrations: AutomationIntegrationsService,
    private readonly processor: AutomationProcessorService,
  ) {}

  // Helpers to read auth context off the JWT-decoded request user
  private getWorkspaceId(req: any): bigint {
    return BigInt(req.user?.workspace_id || 1);
  }
  private getUserId(req: any): bigint {
    return BigInt(req.user?.id || req.user?.user_id || 0);
  }

  // ─── Integrations / canonical registry (frontend pickers consume this) ──

  /**
   * Bulk payload used by the flow builder on load — every connected channel,
   * AI agent, custom field, tag, dify bot, API trigger plus the canonical
   * trigger/action/condition registry the editor's pickers consume.
   *
   * Mirrors replyagent's GET /automation/integrations.
   */
  @Get('integrations')
  async getIntegrations(@Request() req: any) {
    return this.integrations.getIntegrations(this.getWorkspaceId(req));
  }

  /**
   * Compact payload used by the automation listing page — folders +
   * connected-channels summary the "Create flow" modal needs.
   *
   * Mirrors replyagent's GET /automation/data.
   */
  @Get('data')
  async getAutomationData(@Request() req: any) {
    return this.integrations.getAutomationData(this.getWorkspaceId(req));
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

  // ─── Manual triggers ──────────────────────────────────────────────

  /**
   * Inbox-side button: agent opens a conversation and manually fires an
   * automation against the chat's contact. Body: { activity_id, contact_id? }.
   * If contact_id is missing the controller resolves it from the supplied
   * inbox_id (modelable → wa_chats.contact_id).
   *
   * Mirrors replyagent's POST /inbox/automate.
   */
  @Post('inbox-automate')
  async inboxAutomate(@Body() body: any, @Request() req: any) {
    const workspaceId = this.getWorkspaceId(req);
    let contactId: bigint | null = null;

    if (body?.contact_id) {
      try {
        contactId = BigInt(body.contact_id);
      } catch {}
    }
    if (!contactId && body?.inbox_id) {
      const inbox = await this.service.lookupInboxContact(
        BigInt(body.inbox_id),
        workspaceId,
      );
      if (inbox) contactId = inbox;
    }
    if (!contactId) {
      return { triggered: false, reason: 'contact_not_found' };
    }
    if (!body?.activity_id) {
      return { triggered: false, reason: 'activity_id_required' };
    }

    await this.processor.triggerAutomation(
      BigInt(body.activity_id),
      contactId,
    );
    return { triggered: true };
  }

  /**
   * Pipeline-side: when an opportunity moves to a stage that has an
   * automation hook configured, the pipeline service POSTs here to run it.
   * Body: { activity_id, contact_id, opportunity_id? }.
   *
   * Mirrors replyagent's POST /step/{stepId}/trigger-automation, but exposed
   * as a workspace-scoped endpoint instead of a stepId-keyed one. The
   * automation_step_activity's `event = 'opportunity_stage_moved'` plus its
   * properties already carry the stage filter; we just dispatch.
   */
  @Post('pipeline-trigger')
  async pipelineTrigger(@Body() body: any, @Request() req: any) {
    if (!body?.activity_id || !body?.contact_id) {
      return { triggered: false, reason: 'activity_id_and_contact_id_required' };
    }
    await this.processor.triggerAutomation(
      BigInt(body.activity_id),
      BigInt(body.contact_id),
    );
    return { triggered: true };
  }

  /**
   * Import a serialized automation tree (steps + activities + connections +
   * quick replies). Mirrors replyagent's `/automation/import/{id}` route —
   * source is a JSON export from another workspace / bundle.
   *
   * Body shape (mirrors replyagent's exporter):
   *   {
   *     name: string,
   *     folder_id?: string|null,
   *     steps: [{ type, title, properties, slug?, activities: [...] }, ...],
   *     connections: [{ slug, connector_slug, connector_type, next_step_slug }, ...]
   *   }
   *
   * Slugs in the import are remapped to fresh ones so multiple imports
   * coexist without collision.
   */
  @Post('import')
  async importAutomation(@Body() body: any, @Request() req: any) {
    return this.service.importAutomation(
      this.getWorkspaceId(req),
      this.getUserId(req),
      body,
    );
  }

  /**
   * Reconcile a built flow graph (React Flow's nodes + edges) into the
   * canonical step/activity/flow rows the processor executes against.
   *
   * The frontend's previous save approach stored the entire nodes/edges
   * blob inside a single `flow_config` step — which preserved UI state but
   * the processor never saw real step rows. This endpoint translates each
   * node into an `automation_steps` row (with `type` driven by the node's
   * stepType / actionSlug) plus an `automation_step_activities` row
   * carrying the activity slug + properties, then wires connections.
   *
   * Body: { nodes: ReactFlowNode[], edges: ReactFlowEdge[] }
   */
  @Post(':id/sync-graph')
  async syncGraph(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.syncGraph(
      this.getWorkspaceId(req),
      BigInt(id),
      body?.nodes ?? [],
      body?.edges ?? [],
    );
  }

  /**
   * Export a bundle's automations + ancillary data as a JSON tree. The
   * resulting payload is the same shape `POST /automations/import` accepts,
   * so a clone-kit share + import round-trip is a clean copy.
   *
   * Mirrors replyagent's `bundles.*` share flow but limited to the
   * automation slice (other bundle types — flows / templates — would
   * extend this).
   */
  @Get('clone-kit/:bundleId/export')
  async exportCloneKit(
    @Param('bundleId') bundleId: string,
    @Request() req: any,
  ) {
    return this.service.exportCloneKit(
      this.getWorkspaceId(req),
      BigInt(bundleId),
    );
  }

  /**
   * Share an exported clone kit to a recipient workspace. The payload is the
   * JSON tree from `/clone-kit/:bundleId/export`; recipient_workspace_id can
   * be either passed in the body or pulled off the bundle's metadata.
   *
   * Mirrors replyagent's "Share clone kit" button.
   */
  @Post('clone-kit/:bundleId/share')
  async shareCloneKit(
    @Param('bundleId') bundleId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const recipient = body?.recipient_workspace_id
      ? BigInt(body.recipient_workspace_id)
      : null;
    return this.service.shareCloneKit(
      this.getWorkspaceId(req),
      this.getUserId(req),
      BigInt(bundleId),
      recipient,
    );
  }

  /**
   * Authenticated step-level trigger (mirrors replyagent's
   * `POST /step/{stepId}/trigger-automation`). Used by pipeline / report /
   * inbox-side surfaces that already have the step id and want to fire
   * whatever activity sits at the top of it for a given contact.
   */
  /**
   * Stats snapshot for the canvas overlay — returns per-step + per-activity
   * counts pulled from automation_step_statistics + automation_activity_*.
   * Frontend re-fetches every 30s to refresh the badge counts.
   */
  @Get(':id/stats')
  async getStats(@Param('id') id: string, @Request() req: any) {
    return this.service.getStats(
      this.getWorkspaceId(req),
      BigInt(id),
    );
  }

  @Post('step/:stepId/trigger-automation')
  async stepTriggerAutomation(
    @Param('stepId') stepId: string,
    @Body() body: any,
  ) {
    if (!body?.contact_id) {
      return { triggered: false, reason: 'contact_id_required' };
    }
    const resolved = await this.service.stepTriggerAutomation(
      BigInt(stepId),
      BigInt(body.contact_id),
    );
    if (!resolved.triggered || !resolved.activity_id) return resolved;
    await this.processor.triggerAutomation(
      BigInt(resolved.activity_id),
      BigInt(body.contact_id),
    );
    return resolved;
  }
}
