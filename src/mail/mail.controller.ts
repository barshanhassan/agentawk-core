import { Controller, Get, Post, Body, BadRequestException, UseGuards } from '@nestjs/common';
import { MailerService } from './mailer.service';
import { buildEmailHtml } from './email-template';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * Small helper endpoints to test the SMTP setup before wiring it into real flows:
 *   GET  /mail/status        — is SMTP configured? does the connection verify?
 *   POST /mail/test { to }   — fire a test email to any address
 */
@Controller('mail')
@UseGuards(JwtAuthGuard)
export class MailController {
  constructor(private readonly mailer: MailerService) {}

  @Get('status')
  async status() {
    const verify = await this.mailer.verifyConnection();
    return { configured: this.mailer.isConfigured(), verified: verify.ok, error: verify.error };
  }

  @Post('test')
  async test(@Body() body: { to?: string }) {
    const to = (body?.to || '').trim();
    if (!to) throw new BadRequestException('Recipient "to" is required');
    return this.mailer.sendMail({
      to,
      subject: 'AGENTAWK test email ✅',
      html: buildEmailHtml({
        heading: 'AGENTAWK email is working ✅',
        bodyHtml: `<p style="margin:0">This is a test message sent through your configured SMTP server.</p>`,
        footerHtml: `If you received this, the mailer is set up correctly.`,
      }),
      text: 'AGENTAWK email is working — this is a test message from your configured SMTP server.',
    });
  }
}
