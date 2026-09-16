import { Module } from '@nestjs/common';
import { EvalRunner } from './eval.runner';

@Module({
  providers: [EvalRunner],
  exports: [EvalRunner],
})
export class EvalModule {}
