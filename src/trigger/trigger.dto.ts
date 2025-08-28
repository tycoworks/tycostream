import { IsString, IsNotEmpty, IsOptional, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for trigger condition (match or unmatch)
 */
class TriggerConditionDto {
  @IsObject()
  @IsNotEmpty()
  condition: Record<string, any>; // Will be compiled to Expression

  @IsString()
  @IsNotEmpty()
  webhook: string; // URL for webhook delivery
}

/**
 * DTO for creating a new trigger
 * Compatible with Hasura-style API
 */
export class CreateTriggerDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  source: string;

  @ValidateNested()
  @Type(() => TriggerConditionDto)
  @IsNotEmpty()
  match: TriggerConditionDto;

  @ValidateNested()
  @Type(() => TriggerConditionDto)
  @IsOptional()
  unmatch?: TriggerConditionDto;
}