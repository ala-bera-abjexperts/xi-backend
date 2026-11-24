import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AddPortfolioPlanDto {
  @ApiProperty()
  @IsUUID()
  plan_id!: string;
}
