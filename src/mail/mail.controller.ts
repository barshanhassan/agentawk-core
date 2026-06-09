import { Controller, Get, Post, Body, BadRequestException, UseGuards } from '@nestjs/common';
import { MailerService } from './mailer.service';
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
      subject: 'EZCONN test email ✅',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#4f46e5">EZCONN email is working ✅</h2>
          <p>This is a test message sent through your configured SMTP server.</p>
          <p style="color:#888;font-size:12px">If you received this, the mailer is set up correctly.</p>
        </div>`,
      text: 'EZCONN email is working — this is a test message from your configured SMTP server.',
    });
  }
}
