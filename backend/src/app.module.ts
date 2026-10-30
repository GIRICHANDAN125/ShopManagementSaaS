import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { RbacModule } from './rbac/rbac.module';
import { OrdersModule } from './orders/orders.module';
import { DevicesModule } from './devices/devices.module';
import { SuperAdminModule } from './superadmin/superadmin.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PrinterModule } from './printer/printer.module';
import { CatalogModule } from './catalog/catalog.module';
import { EmployeesModule } from './employees/employees.module';
import { SettingsModule } from './settings/settings.module';
import { ReportsModule } from './reports/reports.module';
import { CountersModule } from './counters/counters.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]), // SECURITY.md §9 baseline
    DatabaseModule,
    AuditModule,
    RbacModule,
    AuthModule,
    OrdersModule,
    DevicesModule,
    SuperAdminModule,
    RealtimeModule,
    PrinterModule,
    CatalogModule,
    EmployeesModule,
    SettingsModule,
    ReportsModule,
    CountersModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
