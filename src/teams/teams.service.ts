// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or Update a team
   */
  async createOrUpdate(workspaceId: bigint, userId: bigint, data: any) {
    const { name, members, distribution, auto_assign, id } = data;

    if (!name || !members || !distribution) {
      throw new BadRequestException(
        'Name, members, and distribution are required',
      );
    }

    let team;
    if (id) {
      team = await this.prisma.teams.findUnique({
        where: { id: BigInt(id), workspace_id: workspaceId },
      });
      if (!team) throw new NotFoundException('Team not found');

      team = await this.prisma.teams.update({
        where: { id: team.id },
        data: {
          name,
          distribution,
          auto_assign: auto_assign ? 1 : 0,
          updated_by: userId,
        },
      });
    } else {
      team = await this.prisma.teams.create({
        data: {
          workspace_id: workspaceId,
          name,
          distribution,
          auto_assign: auto_assign ? 1 : 0,
          created_by: userId,
          updated_by: userId,
        },
      });
    }

    // Handle Member Management (Syncing)
    const memberIds = [];
    for (const member of members) {
      const memberUserId = BigInt(member.id);
      memberIds.push(memberUserId);

      const existingMember = await this.prisma.team_members.findFirst({
        where: { team_id: team.id, user_id: memberUserId },
      });

      const memberData: any = {
        priority: distribution === 'PRIORITY' ? member.priority || 0 : null,
        updater_id: userId,
      };

      if (existingMember) {
        await this.prisma.team_members.update({
          where: { id: existingMember.id },
          data: memberData,
        });
      } else {
        await this.prisma.team_members.create({
          data: {
            team_id: team.id,
            user_id: memberUserId,
            creator_id: userId,
            updater_id: userId,
            ...memberData,
          },
        });
      }
    }

    // Delete members not in the new list
    await this.prisma.team_members.deleteMany({
      where: {
        team_id: team.id,
        user_id: { notIn: memberIds },
      },
    });

    // Manual fetch to avoid Prisma include issues
    const updatedTeam = await this.prisma.teams.findUnique({
      where: { id: team.id },
    });

    const refreshedMembers = await this.prisma.team_members.findMany({
      where: { team_id: team.id },
    });

    // Fetch user details manually
    const userIds = refreshedMembers.map(m => m.user_id);
    const users = await this.prisma.users.findMany({
      where: { id: { in: userIds } },
      select: { id: true, full_name: true, first_name: true, email: true }
    });

    return {
      success: true,
      team: {
        ...updatedTeam,
        team_members: refreshedMembers.map(m => ({
          ...m,
          users: users.find(u => u.id === m.user_id)
        }))
      },
    };
  }

  /**
   * List all teams for a workspace
   */
  async getTeams(workspaceId: bigint) {
    const teams = await this.prisma.teams.findMany({
      where: { workspace_id: workspaceId },
    });

    const teamIds = teams.map(t => t.id);
    const allMembers = await this.prisma.team_members.findMany({
      where: { team_id: { in: teamIds } },
    });

    const userIds = [...new Set(allMembers.map(m => m.user_id))];
    const allUsers = await this.prisma.users.findMany({
      where: { id: { in: userIds } },
      select: { id: true, full_name: true, first_name: true, email: true }
    });

    return teams.map(team => ({
      ...team,
      team_members: allMembers
        .filter(m => m.team_id === team.id)
        .map(m => ({
          ...m,
          users: allUsers.find(u => u.id === m.user_id)
        }))
    }));
  }

  /**
   * Distribution-rule based member picker. Used by routing layers (inbox
   * assignment, pipeline auto-assign) to decide which agent gets the next
   * piece of work for this team.
   *
   *  - EQUAL    → round-robin: pick the member with the OLDEST
   *               last_opportunity_assigned_at (NULL counts as oldest).
   *  - PRIORITY → pick the member with the highest priority (smallest int).
   *               Ties broken by oldest last_opportunity_assigned_at.
   *
   * Updates `last_opportunity_assigned_at` + bumps `opportunity_counter` so
   * the next call advances the rotation.
   */
  async pickNextMember(teamId: bigint) {
    const team = await this.prisma.teams.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');

    const orderBy: any[] =
      team.distribution === 'PRIORITY'
        ? [{ priority: 'asc' }, { last_opportunity_assigned_at: { sort: 'asc', nulls: 'first' } }]
        : [{ last_opportunity_assigned_at: { sort: 'asc', nulls: 'first' } }];

    const candidate = await this.prisma.team_members.findFirst({
      where: { team_id: teamId },
      orderBy: orderBy as any,
    });
    if (!candidate) return null;

    await this.prisma.team_members.update({
      where: { id: candidate.id },
      data: {
        last_opportunity_assigned_at: new Date(),
        opportunity_counter: { increment: 1 },
      },
    });
    return candidate;
  }

  /**
   * Delete a team
   */
  async deleteTeam(workspaceId: bigint, teamId: bigint) {
    const team = await this.prisma.teams.findFirst({
      where: { id: teamId, workspace_id: workspaceId },
    });
    if (!team) throw new NotFoundException('Team not found');

    // Delete members first
    await this.prisma.team_members.deleteMany({ where: { team_id: teamId } });
    // Delete team
    await this.prisma.teams.delete({ where: { id: teamId } });

    return { success: true };
  }
}
