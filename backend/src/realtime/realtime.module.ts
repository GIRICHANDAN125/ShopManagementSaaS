import { Injectable, Module, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

/**
 * Tenant-scoped real-time fan-out (ARCHITECTURE.md §9). V1, single
 * instance: in-process Socket.IO room broadcast, no Redis backplane
 * (deferred per DEPLOYMENT.md §8 until a second instance is introduced —
 * not built speculatively here).
 *
 * Room naming is ALWAYS server-derived from the verified JWT's tenantId,
 * never accepted from the client (SECURITY.md §12). A socket is joined to
 * exactly one tenant's namespace and can never be joined to another's,
 * regardless of what the client sends after connecting.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: '*' } }) // dev default; DEPLOYMENT.md restricts this per-environment
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server: Server;

  constructor(private readonly jwt: JwtService, private readonly config: ConfigService) {}

  handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new UnauthorizedException();
      const payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
      if (!payload.tenantId) {
        // Super Admin tokens have no tenant room to join; platform-level
        // sockets are out of scope for this gateway.
        client.disconnect(true);
        return;
      }
      const room = `tenant:${payload.tenantId}:orders`;
      client.join(room);
      (client as any).tenantId = payload.tenantId;
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect() {
    /* no-op: room membership is cleaned up automatically by socket.io */
  }

  onModuleDestroy() {
    if (this.server) {
      this.server.close();
    }
  }

  /** Called by OrdersService/DevicesService after a state change — never
   * called with a room name derived from anything other than the
   * server-resolved tenantId of the acting request. */
  emitOrderStatusChanged(tenantId: string, payload: unknown) {
    this.server.to(`tenant:${tenantId}:orders`).emit('order.status_changed', payload);
  }
}

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.get('JWT_ACCESS_SECRET') }),
    }),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
