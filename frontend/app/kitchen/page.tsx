'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, getToken, clearToken } from '@/lib/api';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001';

interface OrderRow {
  id: string;
  order_number: string;
  display_number: number;
  status: string;
  order_type: string;
}

// Kitchen only cares about CREATED -> PREPARING -> READY. No pricing, no
// admin controls — deliberate scope limit per UI_UX_GUIDELINES.md §5.
const KITCHEN_STATUSES = ['CREATED', 'PREPARING'];
const NEXT_STATUS: Record<string, string> = { CREATED: 'PREPARING', PREPARING: 'READY' };

export default function KitchenPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);

  const refresh = useCallback(async () => {
    const rows: OrderRow[] = await api.listActiveOrders();
    setOrders(rows.filter((o) => KITCHEN_STATUSES.includes(o.status)));
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
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
    await api.updateOrderStatus(order.id, NEXT_STATUS[order.status]);
    refresh();
  }

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <main className="min-h-screen bg-slate-900 p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Kitchen</h1>
        <button onClick={logout} className="text-sm text-slate-400 hover:underline">
          Sign out
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {orders.length === 0 && <p className="text-slate-500 col-span-full">No orders to prepare.</p>}
        {orders.map((o) => (
          <div key={o.id} className="bg-white rounded-2xl p-6">
            <p className="text-4xl font-black text-slate-900 mb-2">
              #{String(o.display_number).padStart(3, '0')}
            </p>
            <p className="text-sm text-slate-500 mb-4">{o.order_type}</p>
            <button
              onClick={() => advance(o)}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white text-xl font-bold py-5 rounded-xl"
            >
              {o.status === 'CREATED' ? 'START' : 'MARK READY'}
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
