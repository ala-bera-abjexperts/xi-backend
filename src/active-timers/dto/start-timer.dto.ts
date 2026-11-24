import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class StartTimerDto {
  @ApiProperty()
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiProperty({ required: false, description: 'Legacy Next.js body alias' })
  @IsOptional()
  @IsUUID()
  taskId?: string;

  @ApiProperty({
    required: false,
    description: 'Legacy body value ignored; org is derived from auth context',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
