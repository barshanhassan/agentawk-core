import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AiProductsService } from './ai-products.service';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * Nested under `/ai-themes/:theme/ai-products` so every operation is scoped
 * to its parent theme — same shape as replyagent's `Route::resource` group.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai-themes/:theme/ai-products')
export class AiProductsController {
  constructor(private readonly aiProductsService: AiProductsService) {}

  @Get()
  list(@Param('theme') theme: string, @Request() req: any) {
    return this.aiProductsService.list(
      BigInt(req.user.workspace_id || 1),
      BigInt(theme),
    );
  }

  @Post()
  create(@Param('theme') theme: string, @Body() body: any, @Request() req: any) {
    return this.aiProductsService.create(
      BigInt(req.user.workspace_id || 1),
      BigInt(theme),
      body,
    );
  }

  @Patch(':product')
  update(
    @Param('theme') theme: string,
    @Param('product') product: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.aiProductsService.update(
      BigInt(req.user.workspace_id || 1),
      BigInt(theme),
      BigInt(product),
      body,
    );
  }

  @Delete(':product')
  delete(
    @Param('theme') theme: string,
    @Param('product') product: string,
    @Request() req: any,
  ) {
    return this.aiProductsService.delete(
      BigInt(req.user.workspace_id || 1),
      BigInt(theme),
      BigInt(product),
    );
  }
}
