import { registerAs } from '@nestjs/config';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { Logger } from '@nestjs/common';
import type { YamlSourcesFile, SourceDefinition, SourceField, EnumType } from './source.types';
import { DataType } from '../common/types';

const logger = new Logger('SourcesConfig');

/**
 * Loads and validates source definitions from YAML schema file
 * Resolves all type information at config load time
 * Fails fast with clear error messages if schema is invalid or missing
 */
export default registerAs('sources', (): Map<string, SourceDefinition> => {
  const sources = new Map<string, SourceDefinition>();
  
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
    const enumDefinitions = new Map<string, EnumType>();
    if (yamlData.enums) {
      for (const [enumName, values] of Object.entries(yamlData.enums)) {
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`Enum '${enumName}' must have at least one value`);
        }
        enumDefinitions.set(enumName, {
          name: enumName,
          values
        });
      }
    }

    // Parse each source
    for (const [sourceName, sourceConfig] of Object.entries(yamlData.sources)) {
      if (!sourceConfig.primary_key) {
        throw new Error(`Source '${sourceName}' missing required 'primary_key' field`);
      }
      
      if (!sourceConfig.columns || Object.keys(sourceConfig.columns).length === 0) {
        throw new Error(`Source '${sourceName}' must have at least one column defined`);
      }
      
      // Verify primary key exists in columns
      if (!sourceConfig.columns[sourceConfig.primary_key]) {
        throw new Error(`Primary key '${sourceConfig.primary_key}' not found in columns for source '${sourceName}'`);
      }
      
      // Build field list with type resolution
      const fields: SourceField[] = Object.entries(sourceConfig.columns).map(([name, typeString]) => {
        let field: SourceField;

        // First check if this references an enum
        const enumDef = enumDefinitions.get(typeString);
        if (enumDef) {
          // This is an enum field
          field = {
            name,
            dataType: DataType.String,  // Enums are strings at runtime
            enumType: enumDef,
          };
        } else {
          // Not an enum, try to parse as a DataType
          try {
            const dataType = getDataType(typeString);
            field = {
              name,
              dataType,
            };
          } catch (error) {
            // Provide better error context
            throw new Error(`Invalid type '${typeString}' for column '${name}' in source '${sourceName}': ${error.message}`);
          }
        }

        return field;
      });
      
      sources.set(sourceName, {
        name: sourceName,
        primaryKeyField: sourceConfig.primary_key,
        fields
      });
    }
    
    logger.log(`Loaded ${sources.size} source definitions: ${Array.from(sources.keys()).join(', ')}`);
    
    // Fail if no sources were loaded
    if (sources.size === 0) {
      throw new Error('No source definitions found in schema file. At least one source must be defined.');
    }
    
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.error(`Schema file not found at ${schemaPath}`);
      throw new Error(`Schema file not found: ${schemaPath}. Please ensure the file exists or set SCHEMA_PATH environment variable.`);
    } else {
      logger.error('Failed to load source definitions');
      throw error;
    }
  }
  
  return sources;
});

/**
 * Convert a type string from YAML to our internal DataType
 * Expects exact DataType enum names in the YAML file
 */
function getDataType(typeName: string): DataType {
  switch (typeName) {
    case 'Integer':
      return DataType.Integer;
    case 'Float':
      return DataType.Float;
    case 'BigInt':
      return DataType.BigInt;
    case 'String':
      return DataType.String;
    case 'UUID':
      return DataType.UUID;
    case 'Timestamp':
      return DataType.Timestamp;
    case 'Date':
      return DataType.Date;
    case 'Time':
      return DataType.Time;
    case 'Boolean':
      return DataType.Boolean;
    case 'JSON':
      return DataType.JSON;
    case 'Array':
      return DataType.Array;
    default:
      throw new Error(`Unknown type in configuration: ${typeName}. Valid types are: Integer, Float, BigInt, String, UUID, Timestamp, Date, Time, Boolean, JSON, Array`);
  }
}