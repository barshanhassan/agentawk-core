import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PERMISSIONS_KEY } from './permissions.decorator';

/**
 * Global guard that enforces `@RequirePermission(...)` decorators. Because
 * it's registered as APP_GUARD it runs BEFORE controller-level
 * `@UseGuards(JwtAuthGuard)`, which means `request.user` is not yet populated
 * by Passport. To avoid an ordering dependency we extract + verify the JWT
 * here ourselves when a permission is required, and also seed `request.user`
 * so downstream handlers can read it.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequirePermission on this route → allow (skip auth check too; the
    // controller's own JwtAuthGuard handles authentication when needed).
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();

    // Prefer request.user when Passport already populated it (controller-level
    // JwtAuthGuard may have run via a different code path).
    let userPerms: string[] = req.user?.permissions ?? [];
    let userId = req.user?.id ?? req.user?.sub;

    // Fallback: parse + verify JWT directly so this guard doesn't depend on
    // execution order with JwtAuthGuard.
    if (!req.user || !Array.isArray(req.user.permissions)) {
      const header = req.headers?.authorization ?? '';
      const token = typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7)
        : null;
      if (!token) {
        this.logger.warn(`403 (no token) on ${req.method} ${req.url}`);
        throw new ForbiddenException('Insufficient permissions');
      }
      try {
        const payload: any = this.jwtService.verify(token, {
          secret:
            this.configService.get<string>('jwt.secret') ||
            'defaultSecretForDevelopmentOnly',
        });
        userPerms = Array.isArray(payload.permissions) ? payload.permissions : [];
        userId = payload.sub;
        // Seed request.user so the route handler still has it (handlers
        // commonly read req.user.sub / .modelable_id etc.).
        if (!req.user) {
          req.user = {
            id: payload.sub,
            sub: payload.sub,
            email: payload.email,
            modelable_id: payload.modelable_id,
            modelable_type: payload.modelable_type,
            role: payload.role,
            workspace_id: payload.workspace_id,
            permissions: userPerms,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `403 (jwt-verify-failed) on ${req.method} ${req.url}: ${err?.message ?? err}`,
        );
        throw new ForbiddenException('Insufficient permissions');
      }
    }

    const hasAll = required.every((perm) => this.check(userPerms, perm));
    if (!hasAll) {
      this.logger.warn(
        `403 on ${req.method} ${req.url} — required=${JSON.stringify(required)} userPerms=${JSON.stringify(userPerms)} user.id=${userId ?? 'none'}`,
      );
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }

  private check(userPerms: string[], required: string): boolean {
    if (userPerms.includes('*')) return true;
    if (userPerms.includes(required)) return true;

    // Wildcard ancestors held by user: 'agency.*' covers 'agency.users.add'
    const parts = required.split('.');
    for (let i = 1; i < parts.length; i++) {
      const wildcard = parts.slice(0, i).join('.') + '.*';
      if (userPerms.includes(wildcard)) return true;
    }

    // Group-wildcard requirement: '@RequirePermission("agency.users.*")' passes
    // if user holds ANY descendant slug. Excludes the top-level namespace
    // 'agency.*' (owner-only — handled above via exact match).
    if (required.endsWith('.*')) {
      const prefix = required.slice(0, -1);
      if (prefix.split('.').filter(Boolean).length > 1) {
        if (userPerms.some((p) => p.startsWith(prefix))) return true;
      }
    }

    return false;
  }
}
