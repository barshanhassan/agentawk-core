import { Module } from '@nestjs/common';
import { AgencyController } from './agency.controller';
import { AgencyService } from './agency.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { DomainsModule } from '../domains/domains.module';
import { OnAgencyUpdatedListener } from './listeners/on-agency-updated.listener';
import { BrandingMediaService } from './branding-media.service';

@Module({
  imports: [PrismaModule, BillingModule, DomainsModule],
  controllers: [AgencyController],
  providers: [AgencyService, OnAgencyUpdatedListener, BrandingMediaService],
  exports: [AgencyService, BrandingMediaService],
})
export class AgencyModule {}
