import { registerAs } from '@nestjs/config';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class GraphQLConfig {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  playground: boolean;
}

export default registerAs('graphql', (): GraphQLConfig => ({
  port: parseInt(process.env.GRAPHQL_PORT || '4000', 10),
  playground: process.env.GRAPHQL_UI === 'true',
}));