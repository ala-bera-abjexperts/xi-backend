import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class CreateAssetObjectReferenceDto {
  @ApiProperty({ description: 'UUID of the target object to link to' })
  @IsUUID('4')
  target_object_id!: string;

  @ApiPropertyOptional({
    description:
      'UUID of the attribute definition that carries this reference (optional)',
  })
  @IsOptional()
  @IsUUID('4')
  attribute_id?: string | null;

  @ApiPropertyOptional({
    description: 'UUID of the relation type that describes the link (optional)',
  })
  @IsOptional()
  @IsUUID('4')
  relation_type_id?: string | null;
}
