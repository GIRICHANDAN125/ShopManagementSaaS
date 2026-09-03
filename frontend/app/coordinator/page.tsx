'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, ApiError, getToken, decodeTokenPayload } from '@/lib/api';
import { PageShell, ErrorText } from '@/lib/ui';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001';

interface OrderRow {
  id: string;
  order_number: string;
  display_number: number;
  status: string;
  order_type: string;
  total: string;
  served_by: string;
}

const NEXT_STATUS: Record<string, string> = {
  CREATED: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COLLECTED',
};

export default function CoordinatorPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listActiveOrders();
      setOrders(rows);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
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
    socket.on('order.status_changed', () => {
      refresh();
    });
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
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }

  return (
    <PageShell title="Coordinator" subtitle="Track and advance active orders.">
      <ErrorText>{error}</ErrorText>
      <div className="space-y-3">
        {orders.length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm border border-dashed border-slate-200 rounded-2xl bg-white">
            No active orders right now.
          </div>
        )}
        {orders.map((o) => (
          <div
            key={o.id}
            className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between shadow-sm"
          >
            <div>
              <p className="text-3xl font-bold text-slate-900">
                {String(o.display_number).padStart(3, '0')}
              </p>
              <p className="text-sm text-slate-500">
                #{o.order_number} · {o.order_type} · ₹{o.total}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold px-3 py-1 rounded-full bg-slate-100 text-slate-700">
                {o.status}
              </span>
              {NEXT_STATUS[o.status] && (
                <button
                  onClick={() => advance(o)}
                  className="bg-slate-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-slate-800 transition-colors"
                >
                  Mark {NEXT_STATUS[o.status]}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
