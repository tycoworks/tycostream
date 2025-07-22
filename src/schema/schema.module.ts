import { Module } from '@nestjs/common';

@Module({
  providers: [
    // TODO: SchemaService (loads YAML schemas)
  ],
  exports: [
    // TODO: Export SchemaService for other modules
  ],
})
export class SchemaModule {}