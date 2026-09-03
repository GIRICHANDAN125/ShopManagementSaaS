'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, getToken, decodeTokenPayload } from '@/lib/api';
import { PageShell } from '@/lib/ui';

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

  const refresh = useCallback(async () => {
    try {
      const rows: OrderRow[] = await api.listActiveOrders();
      setOrders(rows.filter((o) => KITCHEN_STATUSES.includes(o.status)));
    } catch {
      // fallback
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
    await api.updateOrderStatus(order.id, NEXT_STATUS[order.status]);
    refresh();
  }

  return (
    <PageShell title="Kitchen Display" subtitle="Orders awaiting preparation." dark wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {orders.length === 0 && (
          <div className="text-center py-16 text-slate-500 col-span-full border border-dashed border-slate-800 rounded-2xl">
            No orders to prepare right now.
          </div>
        )}
        {orders.map((o) => (
          <div key={o.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-md">
            <p className="text-4xl font-black text-white mb-2">
              #{String(o.display_number).padStart(3, '0')}
            </p>
            <p className="text-sm text-slate-400 mb-4">{o.order_type}</p>
            <button
              onClick={() => advance(o)}
              className={`w-full text-white text-lg font-bold py-4 rounded-xl transition-colors ${
                o.status === 'CREATED'
                  ? 'bg-amber-600 hover:bg-amber-500'
                  : 'bg-emerald-600 hover:bg-emerald-500'
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
