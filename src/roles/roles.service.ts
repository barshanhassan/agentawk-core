import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  // Group slugs intentionally hidden from the role-create permission tree.
  // (User-requested removal — these groups should not appear when building a role.)
  private static readonly HIDDEN_GROUP_SLUGS = new Set<string>([
    'workspace.pipeline.*',    // Pipelines & Opportunities
    'workspace.ai_products.*', // AI Products
    'workspace.bundle.*',      // Bundles
    'workspace.legal.*',       // Legal (workspace-only removal; agency keeps Legal)
    'workspace.booking.*',     // Booking (not used in EZCONN)
  ]);

  // Returns all permissions grouped under a parent slug (e.g. 'agency.*')
  async getPermissionsTree(parentSlug: string) {
    const parent = await this.prisma.acl_permissions.findFirst({
      where: { slug: parentSlug },
    });
    if (!parent) return [];

    // Get all leaf permissions that are descendants of this parent
    const allPerms = await this.prisma.acl_permissions.findMany({
      where: {
        slug: { startsWith: parentSlug.replace('.*', '.') },
        parent_id: { not: null },
      },
      orderBy: { id: 'asc' },
    });

    // Group by immediate parent slug (one level up from leaf)
    const groups: Record<string, { slug: string; name: string; description: string; icon: string | null; tooltip: string | null; children: any[] }> = {};

    for (const perm of allPerms) {
      // Hide non-public permissions from the role-create tree — mirrors
      // replyagent's `v-show="permission.public"` (e.g. Canned Responses and the
      // Pipeline-level permissions are public=false and never shown when building
      // a role; they live in their own dedicated settings screens instead).
      if (perm.public === false) continue;

      if (perm.parent_id === parent.id) {
        // This is a group-level permission (e.g. agency.users.*)
        if (!groups[perm.slug]) {
          groups[perm.slug] = { slug: perm.slug, name: perm.name, description: perm.description || '', icon: perm.icon || null, tooltip: perm.tooltip || null, children: [] };
        }
      } else {
        // Leaf permission — find its group parent
        const groupParent = allPerms.find(p => p.id === perm.parent_id);
        if (groupParent) {
          if (!groups[groupParent.slug]) {
            groups[groupParent.slug] = { slug: groupParent.slug, name: groupParent.name, description: groupParent.description || '', icon: groupParent.icon || null, tooltip: groupParent.tooltip || null, children: [] };
          }
          groups[groupParent.slug].children.push({
            id: this.toStr(perm.id),
            slug: perm.slug,
            name: perm.name,
            description: perm.description || '',
            tooltip: perm.tooltip || null,
            icon: perm.icon || null,
          });
        }
      }
    }

    return Object.values(groups).filter(
      g => g.children.length > 0 && !RolesService.HIDDEN_GROUP_SLUGS.has(g.slug),
    );
  }

  async getRoles(ownerId: bigint, ownerType: string = 'App\\Models\\Workspace') {
    const roles = await this.prisma.acl_roles.findMany({
      where: { ownerable_id: ownerId, ownerable_type: ownerType },
      // Newest first so a freshly created role appears at the top of the list.
      // Order by id (auto-increment PK, never null) rather than created_at,
      // which can be null on Laravel-migrated rows.
      orderBy: { id: 'desc' },
    });

    // Load permissions for each role
    const rolesWithPerms = await Promise.all(roles.map(async (r) => {
      const rolePerms = await this.prisma.acl_role_permissions.findMany({
        where: { role_id: Number(r.id) },
      });
      const permSlugs: string[] = [];
      if (rolePerms.length > 0) {
        const perms = await this.prisma.acl_permissions.findMany({
          where: { id: { in: rolePerms.map(rp => rp.permission_id) } },
          select: { slug: true },
        });
        permSlugs.push(...perms.map(p => p.slug));
      }
      return {
        ...r,
        id: this.toStr(r.id),
        ownerable_id: this.toStr(r.ownerable_id),
        isArchived: r.status === 'ARCHIVE',
        isSystem: r.system,
        permissions: permSlugs,
      };
    }));

    return { roles: rolesWithPerms };
  }

  async createRole(ownerId: bigint, ownerType: string, data: any) {
    // Slug is a stable, unique machine key — mirrors replyagent exactly:
    //   "ar_<ownerId>_<slugified-name>_<unix-timestamp>"
    // The timestamp (+ owner id) guarantees uniqueness even for duplicate role
    // names, so no separate "does this slug exist?" check is ever needed.
    const slug = `ar_${ownerId}_${this.slugifyName(data.name)}_${Math.floor(Date.now() / 1000)}`;
    const role = await this.prisma.acl_roles.create({
      data: {
        ownerable_id: ownerId,
        ownerable_type: ownerType,
        name: data.name,
        slug,
        description: data.description || '',
        icon: data.icon || 'fa-person-military-pointing',
        status: 'ACTIVE',
        system: false,
        admin: false,
      },
    });

    await this.syncPermissions(Number(role.id), data.permissions || []);
    return this.serialize({ ...role, permissions: data.permissions || [] });
  }

  async updateRole(ownerId: bigint, ownerType: string, roleId: bigint, data: any) {
    const role = await this.prisma.acl_roles.findFirst({
      where: { id: roleId, ownerable_id: ownerId, ownerable_type: ownerType },
    });
    if (!role) throw new NotFoundException('Role not found');

    const updateData: any = {};
    // The display name can change, but the slug stays fixed — it is the role's
    // permanent unique key (replyagent parity). User↔role links live in
    // acl_roleables by role_id, so a stable slug never breaks an assignment.
    if (data.name) { updateData.name = data.name; }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.icon) updateData.icon = data.icon;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.isArchived !== undefined) updateData.status = data.isArchived ? 'ARCHIVE' : 'ACTIVE';

    const updated = await this.prisma.acl_roles.update({ where: { id: roleId }, data: updateData });

    if (data.permissions !== undefined) {
      await this.syncPermissions(Number(roleId), data.permissions);
    }

    return this.serialize(updated);
  }

  async deleteRole(ownerId: bigint, ownerType: string, roleId: bigint) {
    // System roles are built-in and must not be deleted (gateway parity).
    const role = await this.prisma.acl_roles.findFirst({
      where: { id: roleId, ownerable_id: ownerId, ownerable_type: ownerType },
      select: { system: true },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.system) throw new BadRequestException('System roles cannot be deleted');

    // Remove the role's permission links first, then the role itself.
    await this.prisma.acl_role_permissions.deleteMany({ where: { role_id: Number(roleId) } });
    // Also clear any user assignments of this role so no user is left pointing at a deleted role.
    await this.prisma.acl_roleables.deleteMany({ where: { role_id: Number(roleId) } });
    return this.prisma.acl_roles.deleteMany({
      where: { id: roleId, ownerable_id: ownerId, ownerable_type: ownerType },
    });
  }

  // Assigns a role to a user (roleable). acl_roleables has only an index (not a
  // unique constraint) on (roleable_type, roleable_id), so we clear any existing
  // link then create — upsert-by-compound-key is not valid here.
  async assignRoleToUser(userId: bigint, roleId: number, entityType: string) {
    await this.prisma.acl_roleables.deleteMany({
      where: { roleable_type: entityType, roleable_id: userId },
    });
    return this.prisma.acl_roleables.create({
      data: { role_id: roleId, roleable_id: userId, roleable_type: entityType },
    });
  }

  private async syncPermissions(roleId: number, permissions: string[]) {
    await this.prisma.acl_role_permissions.deleteMany({ where: { role_id: roleId } });
    if (!permissions || permissions.length === 0) return;

    const perms = await this.prisma.acl_permissions.findMany({
      where: { slug: { in: permissions } },
      select: { id: true },
    });

    if (perms.length > 0) {
      await this.prisma.acl_role_permissions.createMany({
        data: perms.map(p => ({ role_id: roleId, permission_id: p.id })),
        skipDuplicates: true,
      });
    }
  }

  // Laravel Str::slug() equivalent: lowercase, non-alphanumeric runs → single
  // dash, trimmed of leading/trailing dashes. Used to build the role slug.
  private slugifyName(name: string): string {
    return String(name ?? '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private toStr(val: any) {
    return val?.toString() ?? null;
  }

  private serialize(obj: any) {
    return JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
}
