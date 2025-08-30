import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { TriggerController } from './trigger.controller';

@Module({
  imports: [StreamingModule],
  controllers: [TriggerController],
  providers: [],
  exports: []
})
export class TriggerModule {}