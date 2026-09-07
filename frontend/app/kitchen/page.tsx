'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, getToken, decodeTokenPayload } from '@/lib/api';
import { PageShell, Badge, ErrorText } from '@/lib/ui';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001';

interface OrderRow {
  id: string;
  order_number: string;
  display_number: number;
  status: string;
  order_type: string;
}

// Kitchen cares about CREATED -> PREPARING -> READY
const KITCHEN_STATUSES = ['CREATED', 'PREPARING'];
const NEXT_STATUS: Record<string, string> = { CREATED: 'PREPARING', PREPARING: 'READY' };

export default function KitchenPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows: OrderRow[] = await api.listActiveOrders();
      setOrders(rows.filter((o) => KITCHEN_STATUSES.includes(o.status)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.push('/login');
      return;
    }
    const payload = decodeTokenPayload(token);
    const perms = payload?.permissions || [];
    if (!payload?.isSuperAdmin && !perms.includes('order.view') && !perms.includes('*')) {
      router.push('/login');
      return;
    }

    refresh();
    const socket: Socket = io(WS_BASE, { auth: { token } });
    socket.on('order.status_changed', refresh);
    return () => {
      socket.disconnect();
    };
  }, [refresh, router]);

  async function advance(order: OrderRow) {
    if (!NEXT_STATUS[order.status]) return;
    try {
      await api.updateOrderStatus(order.id, NEXT_STATUS[order.status]);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <PageShell title="Kitchen Display" subtitle="Orders awaiting preparation." wide>
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {orders.length === 0 && (
          <div className="text-center py-16 text-slate-400 col-span-full border border-dashed border-slate-200 bg-white rounded-2xl shadow-xs">
            No orders to prepare right now.
          </div>
        )}
        {orders.map((o) => (
          <div
            key={o.id}
            className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-4xl font-black text-slate-900 tracking-tight">
                  #{String(o.display_number).padStart(3, '0')}
                </p>
                <Badge tone={o.status === 'CREATED' ? 'warning' : 'success'}>
                  {o.status === 'CREATED' ? 'New Order' : 'Preparing'}
                </Badge>
              </div>
              <p className="text-sm text-slate-500 mb-6 capitalize font-medium flex items-center gap-1.5">
                <span className="font-mono text-xs text-slate-400">#{o.order_number}</span>
                <span>·</span>
                <span>{o.order_type.replace('_', ' ')}</span>
              </p>
            </div>
            <button
              onClick={() => advance(o)}
              className={`w-full text-white text-base font-bold py-3.5 rounded-xl shadow-xs transition-colors ${
                o.status === 'CREATED'
                  ? 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800'
                  : 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800'
              }`}
            >
              {o.status === 'CREATED' ? 'START PREPARING' : 'MARK READY'}
            </button>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
