import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { generateSchema } from './schema-generator';
import type { SourceDefinition } from '../config/source-definition.types';
import { QueryResolver } from './query.resolver';

@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        // Get source definitions from config
        const sources = configService.get<Map<string, SourceDefinition>>('sources') || new Map();
        
        // Generate SDL from source definitions
        const typeDefs = generateSchema(sources);
        
        return {
          typeDefs,
          playground: true,
          introspection: true,
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [QueryResolver],
})
export class GraphqlModule {}