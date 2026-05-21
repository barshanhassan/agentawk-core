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
import { PipelinesService } from './pipelines.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly service: PipelinesService) {}

  @Get()
  async getPipelines(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.getPipelines(workspaceId, userId);
  }

  @Post()
  async createPipeline(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.createPipeline(workspaceId, userId, body);
  }

  @Get(':id')
  async getPipelineData(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getPipelineData(workspaceId, BigInt(id));
  }

  @Get('steps/:stepId/opportunities')
  async getStepOpportunities(
    @Param('stepId') stepId: string,
    @Query() query: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getStepOpportunities(
      workspaceId,
      BigInt(stepId),
      query,
    );
  }

  @Post('opportunities')
  async createOpportunity(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.createOpportunity(workspaceId, userId, body);
  }

  @Patch('opportunities/:id/status')
  async updateOpportunityStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateOpportunityStatus(
      workspaceId,
      BigInt(id),
      status,
    );
  }

  @Get('steps/:stepId/stats')
  async getStepStats(@Param('stepId') stepId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getStepStats(workspaceId, BigInt(stepId));
  }

  @Post('steps/:stepId/sort')
  async sortOpportunities(
    @Param('stepId') stepId: string,
    @Body('sorted_ids') sortedIds: string[],
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.sortOpportunities(
      workspaceId,
      BigInt(stepId),
      sortedIds,
    );
  }

  @Patch('opportunities/:id/move')
  async moveOpportunity(
    @Param('id') id: string,
    @Body('step_id') stepId: string,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.moveOpportunity(
      workspaceId,
      userId,
      BigInt(id),
      BigInt(stepId),
    );
  }

  @Patch('opportunities/:id')
  async updateOpportunity(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateOpportunity(workspaceId, BigInt(id), body);
  }

  @Delete('opportunities/:id')
  async deleteOpportunity(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteOpportunity(workspaceId, BigInt(id));
  }
}

