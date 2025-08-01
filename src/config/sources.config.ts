import { registerAs } from '@nestjs/config';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { Logger } from '@nestjs/common';
import type { YamlSourcesFile, SourceDefinition, SourceField } from './source-definition.types';

const logger = new Logger('SourcesConfig');

/**
 * Loads and validates source definitions from YAML schema file
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
      
      // Build field list
      const fields: SourceField[] = Object.entries(sourceConfig.columns).map(([name, type]) => ({
        name,
        type
      }));
      
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