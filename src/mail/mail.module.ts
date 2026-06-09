import { Global, Module } from '@nestjs/common';
import { MailerService } from './mailer.service';
import { MailController } from './mail.controller';

/**
 * @Global so any service (auth, workspaces, …) can inject MailerService without
 * re-importing the module — the transactional mailer is a cross-cutting concern.
 */
@Global()
@Module({
  controllers: [MailController],
  providers: [MailerService],
  exports: [MailerService],
})
export class MailModule {}
