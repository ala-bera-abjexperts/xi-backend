import { randomUUID } from 'crypto';
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationWorkerService } from './automation-worker.service';

@ApiExcludeController()
@Controller('automations/cron')
export class AutomationWorkerController {
  constructor(private readonly workerService: AutomationWorkerService) {}

  @Get('work')
  @Public()
  @HttpCode(HttpStatus.OK)
  async runWorker(): Promise<unknown> {
    const workerId = `worker-${randomUUID()}`;
    const stats = await this.workerService.runWorkerLoop(workerId);
    return { ok: true, ...stats };
  }
}
