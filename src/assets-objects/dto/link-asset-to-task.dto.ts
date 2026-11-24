import { IsOptional, IsUUID } from 'class-validator';

export class LinkAssetToTaskDto {
  @IsUUID()
  object_id!: string;

  @IsUUID()
  @IsOptional()
  relation_type_id?: string;
}
