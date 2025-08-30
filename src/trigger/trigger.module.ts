import { Module } from '@nestjs/common';
import { ViewModule } from '../view/view.module';
import { TriggerController } from './trigger.controller';

@Module({
  imports: [ViewModule],
  controllers: [TriggerController],
  providers: [],
  exports: []
})
export class TriggerModule {}