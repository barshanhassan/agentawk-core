import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SwichService } from './swich.service';

/**
 * Public webhook receiver for Swich PayIn callbacks (Section 16 of the
 * integration guide). The guide states the callback is an HTTP GET with the
 * fields as query params — we also accept POST/body defensively, since
 * gateway docs and actual behavior sometimes drift. Swich retries on any
 * non-2xx up to 5 times, 5 minutes apart — this endpoint has no auth guard
 * on purpose (Swich can't send a workspace JWT) and resolves the
 * checksum/lookup internally per transaction.
 */
@Controller('swich/callback')
export class SwichCallbackController {
  constructor(private readonly swich: SwichService) {}

  @Get()
  async receiveGet(@Query() query: any) {
    return this.swich.handleCallback(query);
  }

  @Post()
  async receivePost(@Body() body: any, @Query() query: any) {
    return this.swich.handleCallback({ ...query, ...body });
  }
}
