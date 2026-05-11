import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequirePermission on this route → allow
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    const userPerms: string[] = user?.permissions ?? [];

    const hasAll = required.every(perm => this.check(userPerms, perm));
    if (!hasAll) throw new ForbiddenException('Insufficient permissions');
    return true;
  }

  private check(userPerms: string[], required: string): boolean {
    if (userPerms.includes('*')) return true;
    if (userPerms.includes(required)) return true;

    // Wildcard: 'agency.*' covers 'agency.users.add'
    const parts = required.split('.');
    for (let i = 1; i < parts.length; i++) {
      const wildcard = parts.slice(0, i).join('.') + '.*';
      if (userPerms.includes(wildcard)) return true;
    }
    return false;
  }
}
