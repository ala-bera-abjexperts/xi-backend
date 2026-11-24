import { IsOptional, IsUUID } from 'class-validator';

export class CreateAssetObjectTaskLinkDto {
  @IsUUID()
  task_id!: string;

  @IsUUID()
  @IsOptional()
  relation_type_id?: string;
}
