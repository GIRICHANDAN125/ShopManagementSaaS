'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, ApiError, getToken, clearToken } from '@/lib/api';

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
    refresh();

    // Real-time updates — tenant room membership is resolved server-side
    // from this same token; the client never declares which tenant/room
    // to join (ARCHITECTURE.md §9).
    const socket: Socket = io(WS_BASE, { auth: { token } });
    socket.on('order.status_changed', () => {
      refresh(); // resync via REST rather than trusting the event payload alone (TESTING.md §13)
    });
    return () => {
      socket.disconnect();
    };
  }, [refresh, router]);

  async function advance(order: OrderRow) {
    const next = NEXT_STATUS[order.status];
    if (!next) return;
    await api.updateOrderStatus(order.id, next);
    refresh();
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Coordinator — active orders</h1>
          <button onClick={logout} className="text-sm text-slate-500 hover:underline">
            Sign out
          </button>
        </div>
        {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
        <div className="space-y-3">
          {orders.length === 0 && (
            <p className="text-slate-400 text-sm">No active orders right now.</p>
          )}
          {orders.map((o) => (
            <div
              key={o.id}
              className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between"
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
                    className="bg-slate-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-slate-800"
                  >
                    Mark {NEXT_STATUS[o.status]}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
