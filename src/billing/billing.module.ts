import { Module, Global } from '@nestjs/common';
import { ChargebeeService } from './chargebee.service';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { BillingSyncHelper } from './helpers/billing-sync.helper';
import { WhiteLabelBillingService } from './white-label-billing.service';
import { SubscriptionRecomputeService } from './subscription-recompute.service';
import { OnSubscriptionUpdatedListener } from './listeners/on-subscription-updated.listener';
import { DomainsModule } from '../domains/domains.module';

@Global()
@Module({
  imports: [PrismaModule, ConfigModule, DomainsModule],
  controllers: [BillingController],
  providers: [
    ChargebeeService,
    BillingService,
    BillingSyncHelper,
    WhiteLabelBillingService,
    SubscriptionRecomputeService,
    OnSubscriptionUpdatedListener,
  ],
  exports: [
    ChargebeeService,
    BillingService,
    WhiteLabelBillingService,
    SubscriptionRecomputeService,
  ],
})
export class BillingModule {}
