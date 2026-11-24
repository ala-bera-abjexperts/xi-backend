import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ExecutePlanDto {
  @ApiProperty({
    description: 'ID of the plan_ai_generations record to execute',
  })
  @IsUUID()
  generation_id!: string;
}
