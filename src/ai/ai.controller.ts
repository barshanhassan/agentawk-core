import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AiService } from './ai.service';
import { RagService } from './rag.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly rag: RagService,
  ) {}

  // ─── RAG (knowledge-base retrieval) ─────────────────────────────────

  /** Re-ingest all KB files for an agent (chunk + embed). Call after upload. */
  @Post('agents/:id/kb/ingest')
  async kbIngest(@Param('id') id: string) {
    return this.rag.ingestAgentFiles(BigInt(id));
  }

  /** Semantic search across the agent's KB. Body: { query, top_k? } */
  @Post('agents/:id/kb/search')
  async kbSearch(@Param('id') id: string, @Body() body: any) {
    return this.rag.searchSimilar(BigInt(id), body.query ?? '', body.top_k ?? 5);
  }

  // ─── Agents CRUD ────────────────────────────────────────────────────

  @Get('agents')
  async getAgents(@Request() req: any) {
    return this.aiService.getAgents(BigInt(req.user.workspace_id || 1));
  }

  @Get('agents/search')
  async searchAgents(@Request() req: any, @Body() body: any) {
    return this.aiService.searchAgents(
      BigInt(req.user.workspace_id || 1),
      body.filters,
      body.select,
    );
  }

  @Get('agents/:id')
  async getAgent(@Param('id') id: string, @Request() req: any) {
    return this.aiService.getAgent(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post('agents')
  async saveAgent(@Body() body: any, @Request() req: any) {
    return this.aiService.saveAgent(body, BigInt(req.user.workspace_id || 1));
  }

  @Patch('agents/:id/status')
  async updateAgentStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @Request() req: any,
  ) {
    return this.aiService.updateAgentStatus(
      BigInt(id),
      status,
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post('agents/:id/update')
  async saveUpdateAgent(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.aiService.saveUpdateAgent(
      BigInt(id),
      body,
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post('agents/create')
  async saveUpdateAgentNew(@Body() body: any, @Request() req: any) {
    return this.aiService.saveUpdateAgent(
      null,
      body,
      BigInt(req.user.workspace_id || 1),
    );
  }

  // ─── Legacy Bot Management ──────────────────────────────────────────

  @Post('bot')
  async createBot(@Body() body: any, @Request() req: any) {
    return this.aiService.manageBot(
      null,
      body,
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Patch('bot/:id')
  async updateBot(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.aiService.manageBot(
      BigInt(id),
      body,
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Delete('bot/:id')
  async deleteBot(@Param('id') id: string, @Request() req: any) {
    return this.aiService.deleteBot(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  // ─── Delete Agent ───────────────────────────────────────────────────

  @Delete('agents/:id')
  async deleteAgent(
    @Param('id') id: string,
    @Body('delete_chatgpt') deleteChatgpt: boolean,
    @Request() req: any,
  ) {
    return this.aiService.deleteAgent(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      deleteChatgpt,
    );
  }

  // ─── Functions ──────────────────────────────────────────────────────

  @Delete('functions/:id')
  async removeFunction(@Param('id') id: string) {
    return this.aiService.removeFunction(BigInt(id));
  }

  // ─── Files ──────────────────────────────────────────────────────────

  @Post('files/delete')
  async deleteFile(
    @Body('agent_id') agentId: string,
    @Body('media_id') mediaId: string,
  ) {
    return this.aiService.deleteFile(BigInt(agentId), BigInt(mediaId));
  }

  // ─── Website Scraping ───────────────────────────────────────────────

  @Post('fetch-pages')
  async fetchPages(@Body() body: any) {
    return this.aiService.fetchPages(body);
  }

  // ─── Token Counting ─────────────────────────────────────────────────

  @Post('file-tokens')
  async getFileTokens(@Body('file_url') fileUrl: string) {
    return this.aiService.getFileTokens(fileUrl);
  }

  // ─── Toggle Feeder ──────────────────────────────────────────────────

  @Post('agents/:id/toggle-feeder')
  async toggleFeeder(@Param('id') id: string, @Request() req: any) {
    return this.aiService.toggleFeeder(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  // ─── Try cURL ───────────────────────────────────────────────────────

  @Post('try-curl')
  async trycURL(@Body('curl') curlCommand: string) {
    return this.aiService.trycURL(curlCommand);
  }

  // ─── Message Logs ───────────────────────────────────────────────────

  // ─── Voice Assistants ──────────────────────────────────────────────
  
  @Get('voice-assistants')
  async getVoiceAssistants(@Request() req: any) {
    return this.aiService.getVoiceAssistants(BigInt(req.user.workspace_id || 1));
  }

  @Delete('voice-assistants/:id')
  async deleteVoiceAssistant(@Param('id') id: string, @Request() req: any) {
    return this.aiService.deleteVoiceAssistant(BigInt(id), BigInt(req.user.workspace_id || 1));
  }

  // ─── Knowledge Base ──────────────────────────────────────────────────

  @Get('knowledge-bases')
  async getKnowledgeBases(@Request() req: any) {
    return this.aiService.getKnowledgeBases(BigInt(req.user.workspace_id || 1));
  }

  @Delete('knowledge-bases/:id')
  async deleteKnowledgeBase(@Param('id') id: string, @Request() req: any) {
    return this.aiService.deleteKnowledgeBase(BigInt(id), BigInt(req.user.workspace_id || 1));
  }

  // ─── AI Themes ───────────────────────────────────────────────────────
  
  @Get('themes')
  async getAIThemes(@Request() req: any) {
    return this.aiService.getAIThemes(BigInt(req.user.workspace_id || 1));
  }

  @Post('themes')
  async createAITheme(@Body() body: any, @Request() req: any) {
    return this.aiService.createAITheme(BigInt(req.user.workspace_id || 1), body);
  }

  @Delete('themes/:id')
  async deleteAITheme(@Param('id') id: string, @Request() req: any) {
    return this.aiService.deleteAITheme(BigInt(id), BigInt(req.user.workspace_id || 1));
  }

  // ─── AI Products / Items ────────────────────────────────────────────

  @Get('products')
  async getAIProducts(@Request() req: any) {
    return this.aiService.getAIProducts(BigInt(req.user.workspace_id || 1));
  }

  @Get('themes/:id/products')
  async getProductsByTheme(@Param('id') themeId: string, @Request() req: any) {
    return this.aiService.getAIProductsByTheme(BigInt(req.user.workspace_id || 1), BigInt(themeId));
  }

  @Post('products')
  async createAIProduct(@Body() body: any, @Request() req: any) {
    return this.aiService.createAIProduct(BigInt(req.user.workspace_id || 1), body);
  }

  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string, @Request() req: any) {
    return this.aiService.deleteProduct(BigInt(id), BigInt(req.user.workspace_id || 1));
  }

  @Get('topics')
  async getTopics(@Request() req: any) {
    return this.aiService.getTopics(BigInt(req.user.workspace_id || 1));
  }

  // ─── AI Report Builder ──────────────────────────────────────────────

  @Get('reports')
  async getAIReports(@Request() req: any) {
    return this.aiService.getAIReports(BigInt(req.user.workspace_id || 1));
  }

  @Delete('reports/:id')
  async deleteAIReport(@Param('id') id: string, @Request() req: any) {
    return this.aiService.deleteAIReport(BigInt(id), BigInt(req.user.workspace_id || 1));
  }
}
