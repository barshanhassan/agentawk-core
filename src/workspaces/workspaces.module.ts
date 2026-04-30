import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { AgencyModule } from '../agency/agency.module';
import { DomainsModule } from '../domains/domains.module';

@Module({
  imports: [AgencyModule, DomainsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
