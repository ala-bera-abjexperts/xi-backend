import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationTickService } from './automation-tick.service';

@ApiExcludeController()
@Controller('automations/cron')
export class AutomationTickController {
  constructor(private readonly tickService: AutomationTickService) {}

  @Get('tick')
  @Public()
  @HttpCode(HttpStatus.OK)
  async runTick(): Promise<unknown> {
    try {
      const stats = await this.tickService.runTick();
      return { ok: true, ...stats };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new InternalServerErrorException({ ok: false, error: message });
    }
  }
}
