import { Module } from '@nestjs/common';
import { CsatService } from './csat.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [PrismaModule, WhatsappModule],
  providers: [CsatService],
  exports: [CsatService],
})
export class CsatModule {}
