import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

class ImageSourceDto {
  @IsString()
  @MinLength(1)
  bucket!: string;

  @IsString()
  @MinLength(1)
  path!: string;
}

export class ResolveImagesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImageSourceDto)
  images!: ImageSourceDto[];
}
