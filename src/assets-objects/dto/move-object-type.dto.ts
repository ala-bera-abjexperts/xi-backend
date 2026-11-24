import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class MoveObjectTypeDto {
  @ApiPropertyOptional({
    description:
      'UUID of the new parent type. Omit (or pass null) to move to root level.',
  })
  @IsOptional()
  @IsUUID('4')
  new_parent_id?: string;

  @ApiPropertyOptional({
    description: 'Zero-based position among siblings after the move',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({
    description: 'Optimistic locking — current version from the DB',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  version!: number;
}
