import { registerAs } from '@nestjs/config';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { Logger } from '@nestjs/common';
import type {
  YamlSourcesFile,
  SourceDefinition,
  SourceField,
  EnumType,
  SourceConfiguration,
} from './source.types.js';
import {
  PostgresType,
  postgresTypeName,
  postgresTypeNamed,
} from '../common/types.js';

const logger = new Logger('SourcesConfig');

/**
 * Loads and validates source definitions from YAML schema file
 * Resolves all type information at config load time
 * Fails fast with clear error messages if schema is invalid or missing
 */
export default registerAs('sources', (): SourceConfiguration => {
  const sources = new Map<string, SourceDefinition>();
  const enumDefinitions = new Map<string, EnumType>();

  // Get schema file path from environment or use default
  const schemaPath = process.env.SCHEMA_PATH || './schema.yaml';

  try {
    logger.log(`Loading source definitions from: ${schemaPath}`);

    const yamlContent = readFileSync(schemaPath, 'utf-8');
    const yamlData = load(yamlContent) as YamlSourcesFile;

    if (!yamlData?.sources) {
      throw new Error('Invalid schema file: must contain a "sources" section');
    }

    // Parse enum definitions if present
    if (yamlData.enums) {
      for (const [enumName, values] of Object.entries(yamlData.enums)) {
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`Enum '${enumName}' must have at least one value`);
        }
        enumDefinitions.set(enumName, {
          name: enumName,
          values,
        });
      }
    }

    // Parse each source
    for (const [sourceName, sourceConfig] of Object.entries(yamlData.sources)) {
      if (!sourceConfig.primary_key) {
        throw new Error(
          `Source '${sourceName}' missing required 'primary_key' field`,
        );
      }

      if (
        !sourceConfig.columns ||
        Object.keys(sourceConfig.columns).length === 0
      ) {
        throw new Error(
          `Source '${sourceName}' must have at least one column defined`,
        );
      }

      // Verify primary key exists in columns
      if (!sourceConfig.columns[sourceConfig.primary_key]) {
        throw new Error(
          `Primary key '${sourceConfig.primary_key}' not found in columns for source '${sourceName}'`,
        );
      }

      // Build field list with type resolution
      const fields: SourceField[] = Object.entries(sourceConfig.columns).map(
        ([name, typeString]) => {
          let field: SourceField;

          // First check if this references an enum
          const enumDef = enumDefinitions.get(typeString);
          if (enumDef) {
            // This is an enum field
            field = {
              name,
              type: PostgresType.Text, // Enums are text in the database
              enumType: enumDef,
            };
          } else {
            // Not an enum, so a Postgres type
            try {
              field = { name, type: readColumnType(typeString) };
            } catch (error) {
              // Provide better error context
              throw new Error(
                `Invalid type '${typeString}' for column '${name}' in source '${sourceName}': ${error.message}`,
                { cause: error },
              );
            }
          }

          return field;
        },
      );

      sources.set(sourceName, {
        name: sourceName,
        primaryKeyField: sourceConfig.primary_key,
        fields,
      });
    }

    logger.log(
      `Loaded ${sources.size} source definitions: ${Array.from(sources.keys()).join(', ')}`,
    );

    // Fail if no sources were loaded
    if (sources.size === 0) {
      throw new Error(
        'No source definitions found in schema file. At least one source must be defined.',
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.error(`Schema file not found at ${schemaPath}`);
      throw new Error(
        `Schema file not found: ${schemaPath}. Please ensure the file exists or set SCHEMA_PATH environment variable.`,
        { cause: error },
      );
    } else {
      logger.error('Failed to load source definitions');
      throw error;
    }
  }

  return {
    sources,
    enums: enumDefinitions,
  };
});

/**
 * A column's Postgres type, from its name in schema.yaml, which is its name
 * in Postgres's catalog, such as int4 or timestamptz
 */
function readColumnType(typeName: string): PostgresType {
  const type = postgresTypeNamed(typeName);
  if (type === undefined) {
    const supported = Object.values(PostgresType).map(postgresTypeName);
    throw new Error(
      `Unsupported type in configuration: ${typeName}. Supported types are: ${supported.join(', ')}`,
    );
  }
  return type;
}
