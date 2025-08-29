import { Module } from '@nestjs/common';
import { StreamingModule } from '../streaming/streaming.module';
import { TriggerController } from './trigger.controller';
import { TriggerService } from './trigger.service';

@Module({
  imports: [StreamingModule],
  controllers: [TriggerController],
  providers: [TriggerService],
  exports: [TriggerService]
})
export class TriggerModule {}