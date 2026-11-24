import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { BoardPermissionLevel } from './grant-board-permission.dto';

export class UpdateBoardPermissionDto {
  @ApiProperty({ enum: BoardPermissionLevel })
  @IsEnum(BoardPermissionLevel)
  permission_level!: BoardPermissionLevel;
}
