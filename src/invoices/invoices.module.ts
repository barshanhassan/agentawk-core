import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
