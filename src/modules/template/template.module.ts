import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Template } from './entities/template.entity';
import { TemplateService } from './template.service';
import { TemplateController } from './template.controller';
import { Session } from '../session/entities/session.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Template, Session], 'data')],
  controllers: [TemplateController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
