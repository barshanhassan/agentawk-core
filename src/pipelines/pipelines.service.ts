// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class PipelinesService {
  private readonly logger = new Logger(PipelinesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Get assigned pipelines for a workspace
   */
  async getPipelines(workspaceId: bigint, userId: bigint) {
    // Simplified Logic: Returning all pipelines in workspace for now
    const pipelines = await this.prisma.pipelines.findMany({
      where: { workspace_id: workspaceId },
      include: {
        pipeline_steps: { orderBy: { order: 'asc' } },
      },
    });
    return { success: true, pipelines };
  }

  /**
   * Create a new pipeline with default steps
   */
  async createPipeline(workspaceId: bigint, userId: bigint, data: any) {
    const { name, country_id, currency } = data;

    if (!name) throw new BadRequestException('Pipeline name is required');

    const pipeline = await this.prisma.pipelines.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        name,
        country_id: BigInt(country_id || 1),
        currency: currency || 'USD',
      },
    });

    // Create default steps
    const defaultSteps = [
      'New',
      'Contacted',
      'Proposal',
      'Negotiation',
      'Closed',
    ];
    await Promise.all(
      defaultSteps.map((stepName, index) => {
        return this.prisma.pipeline_steps.create({
          data: {
            pl_id: pipeline.id,
            user_id: userId,
            name: stepName,
            order: index + 1,
          },
        });
      }),
    );

    return {
      success: true,
      pipeline: await this.prisma.pipelines.findUnique({
        where: { id: pipeline.id },
        include: { pipeline_steps: true },
      }),
    };
  }

  /**
   * Get detailed pipeline data including steps and opportunities
   */
  async getPipelineData(workspaceId: bigint, pipelineId: bigint) {
    const pipeline = await this.prisma.pipelines.findUnique({
      where: { id: pipelineId },
      include: {
        pipeline_steps: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!pipeline || pipeline.workspace_id !== workspaceId) {
      throw new NotFoundException('Pipeline not found');
    }

    return { success: true, pipeline };
  }

  /**
   * Filter opportunities for a specific pipeline step
   */
  async getStepOpportunities(workspaceId: bigint, stepId: bigint, query: any) {
    const { search_text, status } = query;

    const where: any = {
      pl_step_id: stepId,
      workspace_id: workspaceId,
      status: status || 'ACTIVE',
    };

    if (search_text) {
      where.OR = [
        { title: { contains: search_text } },
        { note: { contains: search_text } },
      ];
    }

    const opportunities = await this.prisma.pipeline_opportunities.findMany({
      where,
      include: {
        companies: true,
        contacts: true,
      },
      orderBy: { order: 'asc' },
    });

    return { success: true, opportunities };
  }

  /**
   * Create a new opportunity (Deal)
   */
  async createOpportunity(workspaceId: bigint, userId: bigint, data: any) {
    const {
      title,
      pl_id,
      pl_step_id,
      contact_id,
      company_id,
      value,
      closing_date,
    } = data;

    if (!title || !pl_id || !pl_step_id) {
      throw new BadRequestException('Title, Pipeline, and Step are required');
    }

    const opportunity = await this.prisma.pipeline_opportunities.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        title,
        pl_id: BigInt(pl_id),
        pl_step_id: BigInt(pl_step_id),
        contact_id: contact_id ? BigInt(contact_id) : null,
        company_id: company_id ? BigInt(company_id) : null,
        value: parseFloat(value || 0),
        closing_date: closing_date ? new Date(closing_date) : null,
        status: 'ACTIVE',
        currency: 'USD',
        country_id: 1,
      },
    });

    // Log step change
    await this.prisma.pipeline_opportunity_step_logs.create({
      data: {
        pl_opportunity_id: opportunity.id,
        pl_step_id: BigInt(pl_step_id),
        user_id: userId,
        workspace_id: workspaceId,
      },
    });

    return { success: true, opportunity: this.serialize(opportunity) };
  }

  /**
   * Move opportunity to a new step
   */
  async moveOpportunity(workspaceId: bigint, userId: bigint, opportunityId: bigint, stepId: bigint) {
    const opportunity = await this.prisma.pipeline_opportunities.findUnique({
      where: { id: opportunityId, workspace_id: workspaceId }
    });

    if (!opportunity) throw new NotFoundException('Opportunity not found');

    const updated = await this.prisma.pipeline_opportunities.update({
      where: { id: opportunityId },
      data: { pl_step_id: stepId, status_changed_at: new Date() }
    });

    // Log step change
    await this.prisma.pipeline_opportunity_step_logs.create({
      data: {
        pl_opportunity_id: opportunityId,
        pl_step_id: stepId,
        user_id: userId,
        workspace_id: workspaceId,
      },
    });

    // Emit event for automation
    if (updated.contact_id) {
      this.eventEmitter.emit('opportunity.stage_moved', {
        contactId: updated.contact_id,
        pipelineId: updated.pl_id,
        stageId: stepId,
        workspaceId,
      });
    }

    return { success: true, opportunity: this.serialize(updated) };
  }

  private serialize(obj: any) {
    return JSON.parse(
      JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }

  /**
   * Update opportunity status
   */
  async updateOpportunityStatus(
    workspaceId: bigint,
    opportunityId: bigint,
    status: string,
  ) {
    const opportunity = await this.prisma.pipeline_opportunities.update({
      where: { id: opportunityId, workspace_id: workspaceId },
      data: { status, status_changed_at: new Date() },
    });

    return { success: true, opportunity };
  }

  /**
   * Get statistics for a pipeline step
   */
  async getStepStats(workspaceId: bigint, stepId: bigint) {
    const opportunities = await this.prisma.pipeline_opportunities.findMany({
      where: {
        pl_step_id: stepId,
        workspace_id: workspaceId,
        status: 'ACTIVE',
      },
    });

    const totalDeals = opportunities.length;
    const totalValue = opportunities.reduce(
      (acc, opt) => acc + (opt.value || 0),
      0,
    );
    const expectedValue = opportunities.reduce(
      (acc, opt) => acc + (opt.value * (opt.probability || 5)) / 100,
      0,
    );

    return {
      success: true,
      stats: {
        total_deals: totalDeals,
        total_value: totalValue,
        expected_total: expectedValue,
      },
    };
  }

  /**
   * Reorder opportunities in a step (Sort)
   */
  async sortOpportunities(
    workspaceId: bigint,
    stepId: bigint,
    sortedIds: string[],
  ) {
    await Promise.all(
      sortedIds.map((id, index) => {
        return this.prisma.pipeline_opportunities.update({
          where: { id: BigInt(id), workspace_id: workspaceId },
          data: { order: index + 1, pl_step_id: stepId },
        });
      }),
    );

    return { success: true };
  }

  /**
   * Update generic opportunity fields (name, amount, expected_close_date,
   * contact_id, etc.). Status + step moves have their own dedicated methods so
   * automation events fire correctly — keep this method for non-state changes.
   */
  async updateOpportunity(workspaceId: bigint, opportunityId: bigint, data: any) {
    const opp = await this.prisma.pipeline_opportunities.findFirst({
      where: { id: opportunityId, workspace_id: workspaceId },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');

    const update: any = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.amount !== undefined) update.amount = data.amount;
    if (data.expected_close_date !== undefined) update.expected_close_date = data.expected_close_date ? new Date(data.expected_close_date) : null;
    if (data.contact_id !== undefined) update.contact_id = data.contact_id ? BigInt(data.contact_id) : null;
    if (data.lost_reason_id !== undefined) update.pl_lost_reason_id = data.lost_reason_id ? BigInt(data.lost_reason_id) : null;
    if (data.notes !== undefined) update.notes = data.notes;

    const updated = await this.prisma.pipeline_opportunities.update({
      where: { id: opportunityId },
      data: update,
    });
    return { success: true, opportunity: this.serialize(updated) };
  }

  async deleteOpportunity(workspaceId: bigint, opportunityId: bigint) {
    const result = await this.prisma.pipeline_opportunities.deleteMany({
      where: { id: opportunityId, workspace_id: workspaceId },
    });
    if (result.count === 0) throw new NotFoundException('Opportunity not found');
    return { success: true };
  }
}
