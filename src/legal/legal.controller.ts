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
import { LegalService } from './legal.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';

@UseGuards(JwtAuthGuard)
@Controller()
export class LegalController {
  constructor(private readonly service: LegalService) {}

  @Get('legal')
  async list(@Request() req: any) {
    return this.service.list(req.user.modelable_type, BigInt(req.user.modelable_id));
  }

  @Post('legal')
  @RequirePermission('agency.legal.add')
  async create(@Request() req: any, @Body() body: any) {
    return this.service.create(
      req.user.modelable_type,
      BigInt(req.user.modelable_id),
      BigInt(req.user.sub || req.user.id),
      body,
    );
  }

  @Get('legal/accepted')
  async accepted(@Request() req: any) {
    return this.service.getUserAccepted(BigInt(req.user.sub || req.user.id));
  }

  @Get('legal/agency_accepted')
  async agencyAccepted(@Request() req: any) {
    return this.service.getAgencyAccepted(BigInt(req.user.modelable_id));
  }

  @Patch('legal/:id')
  @RequirePermission('agency.legal.edit')
  async update(@Param('id') id: string, @Request() req: any, @Body() body: any) {
    return this.service.update(BigInt(id), BigInt(req.user.sub || req.user.id), body);
  }

  @Delete('legal/:id')
  @RequirePermission('agency.legal.edit')
  async archive(@Param('id') id: string, @Request() req: any) {
    return this.service.archive(BigInt(id), BigInt(req.user.sub || req.user.id));
  }

  @Post('accept-terms')
  async acceptTerms(@Request() req: any, @Body('legal_document_id') docId: string) {
    return this.service.acceptTerms(
      BigInt(req.user.sub || req.user.id),
      BigInt(docId),
    );
  }

  @Post('accept-system-terms')
  async acceptSystemTerms(
    @Request() req: any,
    @Body('system_legal_document_id') docId: string,
  ) {
    return this.service.acceptSystemTerms(BigInt(req.user.modelable_id), BigInt(docId));
  }
}
