import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  webhook: string; // URL for webhook delivery (called with eventType)

  @IsObject()
  @IsNotEmpty()
  match: Record<string, any>; // Match condition (will be compiled to Expression)

  @IsObject()
  @IsOptional()
  unmatch?: Record<string, any>; // Optional unmatch condition (defaults to !match)
}