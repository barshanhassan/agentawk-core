import { Module } from '@nestjs/common';
import { AgencyController } from './agency.controller';
import { AgencyService } from './agency.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { DomainsModule } from '../domains/domains.module';
import { RolesModule } from '../roles/roles.module';

@Module({
  imports: [PrismaModule, BillingModule, DomainsModule, RolesModule],
  controllers: [AgencyController],
  providers: [AgencyService],
  exports: [AgencyService],
})
export class AgencyModule {}
