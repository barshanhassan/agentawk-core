import { Global, Module } from '@nestjs/common';
import { EntriService } from './entri.service';

@Global()
@Module({
  providers: [EntriService],
  exports: [EntriService],
})
export class LibrariesModule {}
