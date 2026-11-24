import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum BoardPermissionLevel {
  VIEW = 'view',
  EDIT = 'edit',
  ADMIN = 'admin',
}

export class GrantBoardPermissionDto {
  @ApiProperty({
    format: 'uuid',
    required: false,
    description:
      'Legacy board UUID echo from Next clients (ignored; path param is authoritative)',
  })
  @IsOptional()
  @IsUUID()
  board_id?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  user_id!: string;

  @ApiProperty({
    enum: BoardPermissionLevel,
    default: BoardPermissionLevel.VIEW,
    required: false,
  })
  @IsOptional()
  @IsEnum(BoardPermissionLevel)
  permission_level?: BoardPermissionLevel;
}
