import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('statistics')
export class StatisticsController {
  constructor(private readonly service: StatisticsService) {}

  @Get('channels')
  async getChannels(@Request() req: any, @Query() params: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.channels(workspaceId, params);
  }

  @Post('charts-data')
  async getChartsData(@Request() req: any, @Body() body: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.chartsData(workspaceId, userId, body);
  }

  @Get('statistics-v1')
  async getStatisticsV1(@Request() req: any, @Query() query: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    // Map query params for date range handling
    const filters = {
      date_range: query.date_range ? JSON.parse(query.date_range) : null,
    };
    return this.service.statisticsV1(workspaceId, filters);
  }

  @Post('statistics-v1')
  async postStatisticsV1(@Request() req: any, @Body() body: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.statisticsV1(workspaceId, body);
  }

  /**
   * Workspace-scoped time-series for the Insights Overview tab. Returns four
   * arrays (dauData, mauData, wauData, stickinessData). Used by OverviewTab
   * to replace what were previously hardcoded mock arrays.
   */
  @Get('dashboard-charts')
  async getDashboardCharts(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getDashboardCharts(workspaceId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Insights Dashboard extended endpoints
  // ═══════════════════════════════════════════════════════════════════════

  /** Overview tab → New Users KPI card (replaces hardcoded +2.5/-1.2/+5.8). */
  @Get('new-users')
  async getNewUsers(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getNewUsersStats(workspaceId);
  }

  /** Performance tab → Agent Performance main view. */
  @Get('agent-performance-main')
  async getAgentPerformanceMain(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getAgentPerformanceMain(workspaceId);
  }

  /** Performance tab → Agent Conversion sub-tab. */
  @Get('agent-conversion')
  async getAgentConversion(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getAgentConversion(workspaceId);
  }

  /** WhatsApp tab → Messages sub-tab. Optional ?country=US filter. */
  @Get('whatsapp-messages')
  async getWhatsappMessages(@Request() req: any, @Query('country') country?: string) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getWhatsappMessages(workspaceId, country);
  }

  /** WhatsApp tab → Calls sub-tab. */
  @Get('whatsapp-calls')
  async getWhatsappCalls(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getWhatsappCalls(workspaceId);
  }

  /** Bot tab analytics. */
  @Get('bot-analytics')
  async getBotAnalytics(@Request() req: any, @Query('top') top?: string) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getBotAnalytics(workspaceId, top || 'Top 10');
  }

  /** Voice of Customer → Summary sub-tab. */
  @Get('sentiment-summary')
  async getSentimentSummary(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getSentimentSummary(workspaceId);
  }

  /** Voice of Customer → Details sub-tab. */
  @Get('sentiment-details')
  async getSentimentDetails(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getSentimentDetails(workspaceId);
  }

  /** CSAT → Summary sub-tab (honest empty state). */
  @Get('csat-summary')
  async getCsatSummary(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getCsatSummary(workspaceId);
  }

  /** CSAT → Details sub-tab (honest empty state). */
  @Get('csat-details')
  async getCsatDetails(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getCsatDetails(workspaceId);
  }
}
