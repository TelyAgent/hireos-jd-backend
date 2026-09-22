import { Module } from '@nestjs/common';
import { WorkspaceGuard } from './workspace.guard';

@Module({
  providers: [WorkspaceGuard],
  exports: [WorkspaceGuard],
})
export class AuthModule {}
