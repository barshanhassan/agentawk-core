import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import { DomainsService } from './domains.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('domains')
export class DomainsController {
  constructor(private readonly service: DomainsService) {}

  @Post('add-custom-domain')
  async addCustomDomain(@Body() body: any, @Request() req: any) {
    return this.service.addCustomDomain(
      BigInt(req.user.workspace_id || 1),
      req.user.site_type || 'WORKSPACE',
      body.sub_domain,
      body.root_domain,
      BigInt(req.user.sub),
    );
  }

  @Get('current')
  async getCurrentDomain(@Request() req: any) {
    return this.service.getCustomDomain(
      BigInt(req.user.workspace_id || 1),
      req.user.site_type || 'WORKSPACE',
    );
  }

  @Get('validate-domain')
  async validateDomain(
    @Query('sub_domain') subDomain: string,
    @Query('root_domain') rootDomain: string,
  ) {
    return this.service.validateDomain(subDomain, rootDomain);
  }

  @Delete('delete-custom-domain')
  async deleteCustomDomain(@Request() req: any) {
    return this.service.deleteCustomDomain(
      BigInt(req.user.workspace_id || 1),
      req.user.site_type || 'WORKSPACE',
    );
  }

  @Get('entri-token')
  async getEntriToken() {
    return this.service.getEntriToken();
  }
}
