import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  UseGuards,
  Request,
  Param,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  async getTasks(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTasks(workspaceId, query);
  }

  @Post()
  async saveTask(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    const workspaceTimezone = req.user.workspace_timezone || 'UTC';
    return this.service.saveTask(workspaceId, userId, workspaceTimezone, body);
  }

  @Patch(':id')
  async updateTask(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateTask(workspaceId, BigInt(id), body);
  }

  /**
   * Mark a task COMPLETED — used by the Contact Profile sidebar's checkmark
   * button. Dedicated route so we can emit a future `task.completed` event.
   */
  @Post(':id/complete')
  async completeTask(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.completeTask(workspaceId, BigInt(id));
  }

  @Delete(':id')
  async deleteTask(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteTask(workspaceId, BigInt(id));
  }
}
