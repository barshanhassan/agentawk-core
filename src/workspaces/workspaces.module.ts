import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { PlanFeaturesService } from './plan-features.service';
import { RolesModule } from '../roles/roles.module';

@Module({
  imports: [RolesModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, PlanFeaturesService],
  exports: [WorkspacesService, PlanFeaturesService],
})
export class WorkspacesModule {}
