import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { SaveMenuPermissionDto } from './save-menu-permission.dto';

export class BulkMenuPermissionDto {
  @ApiProperty({ type: [SaveMenuPermissionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveMenuPermissionDto)
  permissions!: SaveMenuPermissionDto[];
}
