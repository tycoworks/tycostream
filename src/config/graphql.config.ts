import { registerAs } from '@nestjs/config';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { validateConfig } from './config-validation';

export class GraphQLConfig {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @IsBoolean()
  playground: boolean;
}

export default registerAs('graphql', (): GraphQLConfig => {
  const rawConfig = {
    port: parseInt(process.env.GRAPHQL_PORT || '4000', 10),
    playground: process.env.GRAPHQL_UI === 'true',
  };
  
  return validateConfig(rawConfig, 'graphql', GraphQLConfig);
});