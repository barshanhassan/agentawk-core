// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get tasks for a workspace with optional filters
   */
  async getTasks(workspaceId: bigint, query: any) {
    const { contact_id, company_id, user_id, status } = query;
    const where: any = { workspace_id: workspaceId };

    if (contact_id) where.contact_id = BigInt(contact_id);
    if (company_id) where.company_id = BigInt(company_id);
    if (user_id) where.user_id = BigInt(user_id);
    if (status) where.status = status;

    const tasks = await this.prisma.tasks.findMany({
      where,
      orderBy: { datetime: 'asc' },
    });

    if (!tasks.length) return { success: true, tasks: [] };

    // Manual joins — tasks model has no @relation fields in Prisma
    const contactIds = [...new Set(tasks.map((t) => t.contact_id).filter(Boolean))] as bigint[];
    const companyIds = [...new Set(tasks.map((t) => t.company_id).filter(Boolean))] as bigint[];
    const userIds = [...new Set(tasks.map((t) => t.user_id).filter(Boolean))] as bigint[];

    const [contacts, companies, users] = await Promise.all([
      contactIds.length
        ? this.prisma.contacts.findMany({ where: { id: { in: contactIds } }, select: { id: true, full_name: true, first_name: true, last_name: true } })
        : Promise.resolve([]),
      companyIds.length
        ? this.prisma.companies.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
        : Promise.resolve([]),
    ]);

    const contactMap = new Map(contacts.map((c) => [c.id.toString(), c]));
    const companyMap = new Map(companies.map((c) => [c.id.toString(), c]));
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));

    const enriched = tasks.map((t) => ({
      ...t,
      contacts: t.contact_id ? (contactMap.get(t.contact_id.toString()) ?? null) : null,
      companies: t.company_id ? (companyMap.get(t.company_id.toString()) ?? null) : null,
      users: t.user_id ? (userMap.get(t.user_id.toString()) ?? null) : null,
    }));

    return { success: true, tasks: enriched };
  }

  /**
   * Create or Update a task
   */
  async saveTask(
    workspaceId: bigint,
    creatorId: bigint,
    workspaceTimezone: string,
    data: any,
  ) {
    const { id, date, time, description, contact_id, user_id } = data;

    if (!date || !time || !description || !contact_id) {
      throw new BadRequestException(
        'Date, Time, Description and Contact are required',
      );
    }

    // Convert local datetime to UTC
    let utcDateTime: Date;
    try {
      const localStr = `${date} ${time}`;
      utcDateTime = dayjs.tz(localStr, workspaceTimezone).utc().toDate();

      if (dayjs(utcDateTime).isBefore(dayjs())) {
        throw new BadRequestException('Task must be in the future');
      }
    } catch (e) {
      throw new BadRequestException('Invalid date or time format');
    }

    const contact = await this.prisma.contacts.findUnique({
      where: { id: BigInt(contact_id) },
    });

    if (!contact) throw new NotFoundException('Contact not found');

    const payload: any = {
      workspace_id: workspaceId,
      user_id: user_id ? BigInt(user_id) : null,
      creator_id: creatorId,
      contact_id: contact.id,
      company_id: contact.company_id || BigInt(0), // Mirroring Laravel default
      description,
      datetime: utcDateTime,
      status: 'ACTIVE',
    };

    let task;
    if (id) {
      task = await this.prisma.tasks.update({
        where: { id: BigInt(id), workspace_id: workspaceId },
        data: payload,
      });
    } else {
      task = await this.prisma.tasks.create({
        data: payload,
      });

      // Logic to link inbox/event if needed (mirrors Laravel linkInbox)
      this.logger.log(
        `Task created: linking to inbox for contact ${contact_id}`,
      );
    }

    return { success: true, task };
  }

  /**
   * Delete a task
   */
  async deleteTask(workspaceId: bigint, taskId: bigint) {
    await this.prisma.tasks.delete({
      where: { id: taskId, workspace_id: workspaceId },
    });

    return { success: true };
  }

  /**
   * Partial update for an existing task. Accepts any subset of the
   * task columns the frontend allows users to edit (status, datetime,
   * description, user_id). Used by the sidebar complete (✅) and snooze
   * (🔔) buttons in the Contact Profile modal.
   */
  async updateTask(workspaceId: bigint, taskId: bigint, data: any) {
    const task = await this.prisma.tasks.findFirst({
      where: { id: taskId, workspace_id: workspaceId },
    });
    if (!task) throw new NotFoundException('Task not found');

    const update: any = {};
    if (data.status !== undefined) update.status = data.status;
    if (data.description !== undefined) update.description = data.description;
    if (data.user_id !== undefined)
      update.user_id = data.user_id ? BigInt(data.user_id) : null;
    if (data.datetime !== undefined) {
      // Accept ISO strings or epoch numbers — convert to Date.
      update.datetime = data.datetime ? new Date(data.datetime) : null;
    }

    if (Object.keys(update).length === 0) {
      return { success: true, task };
    }

    const updated = await this.prisma.tasks.update({
      where: { id: taskId },
      data: update,
    });
    return { success: true, task: updated };
  }

  /**
   * Convenience endpoint: mark a task COMPLETED. Replyagent parity for the
   * sidebar checkmark button — keeping it a dedicated route lets us emit a
   * future `task.completed` event without complicating updateTask.
   */
  async completeTask(workspaceId: bigint, taskId: bigint) {
    return this.updateTask(workspaceId, taskId, { status: 'COMPLETED' });
  }
}
