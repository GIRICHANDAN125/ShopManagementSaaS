'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, ApiError, getToken, decodeTokenPayload, getWsBaseUrl } from '@/lib/api';
import { PageShell, ErrorText, Badge } from '@/lib/ui';


interface OrderItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: string | number;
  lineTotal: string | number;
}

interface OrderRow {
  id: string;
  order_number: string;
  display_number: number;
  status: string;
  order_type: string;
  total: string;
  served_by: string;
  created_at: string;
  items?: OrderItem[];
}

const NEXT_STATUS: Record<string, string> = {
  CREATED: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COLLECTED',
};

const STATUS_TONES: Record<string, 'warning' | 'neutral' | 'success' | 'danger'> = {
  CREATED: 'warning',
  PREPARING: 'neutral',
  READY: 'success',
};

export default function CoordinatorPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('ALL');

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

    const socket: Socket = io(getWsBaseUrl(), { auth: { token } });
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

  const filteredOrders = useMemo(() => {
    if (activeFilter === 'ALL') return orders;
    return orders.filter((o) => o.status === activeFilter);
  }, [orders, activeFilter]);

  const counts = useMemo(() => {
    return {
      ALL: orders.length,
      CREATED: orders.filter((o) => o.status === 'CREATED').length,
      PREPARING: orders.filter((o) => o.status === 'PREPARING').length,
      READY: orders.filter((o) => o.status === 'READY').length,
    };
  }, [orders]);

  return (
    <PageShell title="Order Coordinator" subtitle="Monitor active orders, track items, and advance status." wide>
      <ErrorText>{error}</ErrorText>

      {/* Filter Tabs & Summary Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200">
          {(['ALL', 'CREATED', 'PREPARING', 'READY'] as const).map((filterKey) => (
            <button
              key={filterKey}
              onClick={() => setActiveFilter(filterKey)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeFilter === filterKey
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {filterKey === 'ALL' ? 'All Active' : filterKey}{' '}
              <span
                className={`ml-1 text-[11px] px-1.5 py-0.2 rounded-full ${
                  activeFilter === filterKey ? 'bg-slate-100 text-slate-800' : 'bg-slate-200/70 text-slate-600'
                }`}
              >
                {counts[filterKey]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Active Orders List */}
      <div className="space-y-4">
        {filteredOrders.length === 0 && (
          <div className="text-center py-16 text-slate-400 text-sm border border-dashed border-slate-200 rounded-2xl bg-white shadow-xs">
            <svg className="w-10 h-10 mx-auto text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="font-semibold text-slate-600">No active orders found</p>
            <p className="text-xs text-slate-400 mt-1">
              {activeFilter === 'ALL'
                ? 'When Counter creates an order, it will appear here in real time.'
                : `No orders currently in ${activeFilter} status.`}
            </p>
          </div>
        )}

        {filteredOrders.map((o) => (
          <div
            key={o.id}
            className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col md:flex-row md:items-center justify-between gap-5"
          >
            {/* Header info & display number */}
            <div className="flex items-start gap-4 min-w-[240px]">
              <div className="bg-slate-900 text-white rounded-xl px-4 py-3 text-center shadow-xs">
                <span className="text-[10px] uppercase font-semibold tracking-wider text-slate-400 block">Token</span>
                <span className="text-3xl font-black tracking-tight">
                  #{String(o.display_number).padStart(3, '0')}
                </span>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs font-bold text-slate-500">#{o.order_number}</span>
                  <Badge tone={STATUS_TONES[o.status] || 'neutral'}>
                    {o.status}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 font-medium capitalize">
                  <span>{o.order_type ? o.order_type.replace('_', ' ') : 'Dine-in'}</span>
                  <span className="mx-1.5">·</span>
                  <span className="font-bold text-slate-900">₹{Number(o.total).toFixed(2)}</span>
                </p>
                {o.served_by && (
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Served by: <span className="font-semibold text-slate-600">{o.served_by}</span>
                  </p>
                )}
              </div>
            </div>

            {/* Ordered Items List */}
            <div className="flex-1 border-t md:border-t-0 md:border-l border-slate-100 pt-3 md:pt-0 md:pl-5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                Ordered Items ({o.items?.reduce((acc, item) => acc + item.quantity, 0) || 0})
              </p>
              {o.items && o.items.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {o.items.map((item, idx) => (
                    <div
                      key={item.id || idx}
                      className="bg-slate-50 border border-slate-200/80 px-2.5 py-1 rounded-lg text-xs flex items-center gap-1.5"
                    >
                      <span className="font-black text-slate-900 bg-slate-200/80 px-1.5 py-0.5 rounded text-[11px]">
                        {item.quantity}×
                      </span>
                      <span className="font-medium text-slate-800">{item.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic">No item details available</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end border-t md:border-t-0 border-slate-100 pt-3 md:pt-0 min-w-[170px]">
              {NEXT_STATUS[o.status] ? (
                <button
                  onClick={() => advance(o)}
                  className={`w-full md:w-auto text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow-xs transition-colors ${
                    o.status === 'CREATED'
                      ? 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800'
                      : o.status === 'PREPARING'
                      ? 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800'
                      : 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800'
                  }`}
                >
                  Mark {NEXT_STATUS[o.status]}
                </button>
              ) : (
                <span className="text-xs text-slate-400 font-semibold px-3 py-1 bg-slate-100 rounded-lg">
                  Completed
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

