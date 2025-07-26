import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Logger } from '@nestjs/common';

const logger = new Logger('ConfigValidation');

export function validateConfig<T extends object>(
  config: Record<string, any>,
  envVariablesKey: string,
  validationClass: new () => T,
): T {
  const validatedConfig = plainToInstance(validationClass, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig as object, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const errorMessages = errors
      .map(error => Object.values(error.constraints || {}).join(', '))
      .join('; ');
    
    logger.error(`Configuration validation failed for ${envVariablesKey}`);
    throw new Error(`Invalid configuration for ${envVariablesKey}: ${errorMessages}`);
  }

  return validatedConfig;
}