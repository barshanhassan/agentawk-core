import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Request } from 'express';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret') || 'defaultSecretForDevelopmentOnly',
      passReqToCallback: true, // Enable access to request object
    });
  }

  async validate(req: Request, payload: any) {
    const user = await this.prisma.users.findUnique({
      where: { id: BigInt(payload.sub) },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User not found or inactive');
    }

    // Get site context from middleware (injected by DomainCachingMiddleware)
    const site_type = req.site_type || null;
    const site_id = req.site_id || null;
    const site_domain = req.site_domain || null;

    return {
      id: user.id.toString(),
      sub: user.id.toString(),
      email: user.email,
      modelable_id: user.modelable_id?.toString(),
      modelable_type: user.modelable_type,
      workspace_id: (
        user.active_workspace_id || 
        (user.modelable_type === 'App\\Models\\Workspace' ? user.modelable_id : null)
      )?.toString(),
      // Site context from domain middleware
      site_type: site_type,
      site_id: site_id,
      site_domain: site_domain,
    };
  }
}
