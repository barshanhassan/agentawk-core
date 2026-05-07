import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async getRoles(ownerId: bigint, ownerType: string = 'App\\Models\\Workspace') {
    const roles = await this.prisma.acl_roles.findMany({
      where: {
        ownerable_id: ownerId,
        ownerable_type: ownerType
      }
    });

    const results = roles.map(r => ({
      ...r,
      isArchived: r.status === 'ARCHIVE',
      permissions: {}, 
    }));

    return this.serialize(results);
  }

  async createRole(ownerId: bigint, ownerType: string, data: any) {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const role = await this.prisma.acl_roles.create({
      data: {
        ownerable_id: ownerId,
        ownerable_type: ownerType,
        name: data.name,
        slug: slug,
        description: data.description || '',
        icon: data.icon || 'fa-user-tie',
        status: 'ACTIVE',
        system: false,
        admin: false,
      }
    });

    // Handle permissions
    if (data.permissions) {
      for (const [key, enabled] of Object.entries(data.permissions)) {
        if (enabled) {
          const permission = await this.prisma.acl_permissions.findFirst({
            where: { slug: key }
          });
          if (permission) {
            await this.prisma.acl_role_permissions.create({
              data: {
                role_id: Number(role.id),
                permission_id: permission.id
              }
            });
          }
        }
      }
    }

    return this.serialize(role);
  }

  async updateRole(ownerId: bigint, ownerType: string, roleId: bigint, data: any) {
    const role = await this.prisma.acl_roles.findFirst({
      where: {
        id: roleId,
        ownerable_id: ownerId,
        ownerable_type: ownerType
      }
    });

    if (!role) throw new NotFoundException('Role not found');

    const updateData: any = {};
    if (data.name) {
      updateData.name = data.name;
      updateData.slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.icon) updateData.icon = data.icon;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.isArchived !== undefined) updateData.status = data.isArchived ? 'ARCHIVE' : 'ACTIVE';

    const updated = await this.prisma.acl_roles.update({
      where: { id: roleId },
      data: updateData,
    });

    // Sync permissions
    if (data.permissions) {
      // Delete old ones first
      await this.prisma.acl_role_permissions.deleteMany({
        where: { role_id: Number(roleId) }
      });

      // Add new ones
      for (const [key, enabled] of Object.entries(data.permissions)) {
        if (enabled) {
          const permission = await this.prisma.acl_permissions.findFirst({
            where: { slug: key }
          });
          if (permission) {
            await this.prisma.acl_role_permissions.create({
              data: {
                role_id: Number(roleId),
                permission_id: permission.id
              }
            });
          }
        }
      }
    }

    return this.serialize(updated);
  }

  async deleteRole(ownerId: bigint, ownerType: string, roleId: bigint) {
    return this.prisma.acl_roles.deleteMany({
      where: {
        id: roleId,
        ownerable_id: ownerId,
        ownerable_type: ownerType
      }
    });
  }

  private serialize(obj: any) {
    return JSON.parse(
      JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}
