import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

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
    });
  }

  async validate(payload: any) {
    const user = await this.prisma.users.findUnique({
      where: { id: BigInt(payload.sub) },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User not found or inactive');
    }

    return {
      id: user.id.toString(),
      sub: payload.sub,
      email: user.email,
      modelable_id: user.modelable_id?.toString(),
      modelable_type: user.modelable_type,
      role: payload.role,
      is_owner: user.is_owner,
      // Surface permissions array from the JWT payload so PermissionsGuard can enforce
      // @RequirePermission(...) on routes. Owners get wildcard slugs ('agency.*'/'workspace.*').
      permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
      workspace_id: (user.active_workspace_id || (user.modelable_type === 'App\\Models\\Workspace' ? user.modelable_id : null))?.toString(),
    };
  }
}
