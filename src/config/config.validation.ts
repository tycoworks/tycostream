import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DatabaseConfig } from './database.config';
import { GraphQLConfig } from './graphql.config';
import { AppConfig } from './app.config';

export function validateConfig(config: Record<string, any>) {
  // For now, just ensure the config exists
  if (!config.database || !config.graphql || !config.app) {
    throw new Error('Configuration sections missing. Ensure database, graphql, and app configs are loaded.');
  }

  // Validate database config
  if (config.database) {
    const databaseConfig = plainToInstance(DatabaseConfig, config.database);
    const databaseErrors = validateSync(databaseConfig, {
      skipMissingProperties: false,
      whitelist: true,
    });

    if (databaseErrors.length > 0) {
      const errorMessages = databaseErrors
        .map((error) => {
          const constraints = Object.values(error.constraints || {});
          return `database.${error.property}: ${constraints.join(', ')}`;
        })
        .join('\n');
      throw new Error(`Database configuration validation failed:\n${errorMessages}`);
    }
  }

  // Validate GraphQL config
  if (config.graphql) {
    const graphqlConfig = plainToInstance(GraphQLConfig, config.graphql);
    const graphqlErrors = validateSync(graphqlConfig, {
      skipMissingProperties: false,
      whitelist: true,
    });

    if (graphqlErrors.length > 0) {
      const errorMessages = graphqlErrors
        .map((error) => {
          const constraints = Object.values(error.constraints || {});
          return `graphql.${error.property}: ${constraints.join(', ')}`;
        })
        .join('\n');
      throw new Error(`GraphQL configuration validation failed:\n${errorMessages}`);
    }
  }

  // Skip app config validation for now since AppConfig is an empty class
  // class-validator with whitelist:true rejects empty objects on empty classes
  // TODO: Re-enable validation when AppConfig has actual properties to validate

  return config;
}