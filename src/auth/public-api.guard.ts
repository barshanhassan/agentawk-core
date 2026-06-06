import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Authenticates incoming requests against `users.api_token`. The token is
 * issued by `POST /api/users/public-api-token` (Developer Settings → API
 * Key). Mirrors replyagent's Sanctum `auth:api` middleware semantics but
 * stays JWT-free — we just hash-compare the bearer against the column.
 *
 * On success: attaches `req.user = { sub, workspace_id, is_owner }` so
 * downstream controllers can authorise per workspace the same way JWT
 * routes do.
 */
@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth: string = req.headers?.authorization ?? '';
    if (!auth.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const token = auth.slice('bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing token');
    }

    const user = await this.prisma.users.findFirst({
      where: { api_token: token },
      select: {
        id: true,
        active_workspace_id: true,
        is_owner: true,
        modelable_id: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid API token');
    }

    req.user = {
      sub: String(user.id),
      workspace_id: String(user.active_workspace_id ?? user.modelable_id),
      is_owner: user.is_owner,
      via: 'public_api_token',
    };
    return true;
  }
}
