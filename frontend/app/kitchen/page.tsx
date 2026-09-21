'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import io, { Socket } from 'socket.io-client';
import { api, getToken, decodeTokenPayload, getWsBaseUrl } from '@/lib/api';
import { PageShell, Badge, ErrorText } from '@/lib/ui';


interface OrderItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
}

interface OrderRow {
  id: string;
  order_number: string;
  display_number: number;
  status: string;
  order_type: string;
  items?: OrderItem[];
}

// Kitchen cares about CREATED -> PREPARING -> READY
const KITCHEN_STATUSES = ['CREATED', 'PREPARING'];
const NEXT_STATUS: Record<string, string> = { CREATED: 'PREPARING', PREPARING: 'READY' };

export default function KitchenPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('ALL');

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
    const socket: Socket = io(getWsBaseUrl(), { auth: { token } });
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

  const filteredOrders = useMemo(() => {
    if (activeFilter === 'ALL') return orders;
    return orders.filter((o) => o.status === activeFilter);
  }, [orders, activeFilter]);

  const counts = useMemo(() => {
    return {
      ALL: orders.length,
      CREATED: orders.filter((o) => o.status === 'CREATED').length,
      PREPARING: orders.filter((o) => o.status === 'PREPARING').length,
    };
  }, [orders]);

  return (
    <PageShell title="Kitchen Display System" subtitle="Orders awaiting preparation and cooking." wide>
      <ErrorText>{error}</ErrorText>

      {/* Filter Tabs & Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200">
          <button
            onClick={() => setActiveFilter('ALL')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeFilter === 'ALL'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Kitchen Orders{' '}
            <span className="ml-1 text-[11px] px-1.5 py-0.2 rounded-full bg-slate-200/70 text-slate-700">
              {counts.ALL}
            </span>
          </button>

          <button
            onClick={() => setActiveFilter('CREATED')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeFilter === 'CREATED'
                ? 'bg-white text-amber-700 shadow-xs'
                : 'text-slate-600 hover:text-amber-700'
            }`}
          >
            New Orders{' '}
            <span className="ml-1 text-[11px] px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-800">
              {counts.CREATED}
            </span>
          </button>

          <button
            onClick={() => setActiveFilter('PREPARING')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeFilter === 'PREPARING'
                ? 'bg-white text-emerald-700 shadow-xs'
                : 'text-slate-600 hover:text-emerald-700'
            }`}
          >
            In Preparation{' '}
            <span className="ml-1 text-[11px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-800">
              {counts.PREPARING}
            </span>
          </button>
        </div>
      </div>

      {/* Orders Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredOrders.length === 0 && (
          <div className="text-center py-16 text-slate-400 col-span-full border border-dashed border-slate-200 bg-white rounded-2xl shadow-xs">
            <svg className="w-12 h-12 mx-auto text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <p className="font-semibold text-slate-600">No orders to prepare right now</p>
            <p className="text-xs text-slate-400 mt-1">
              New orders created at the Counter will instantly appear on this screen.
            </p>
          </div>
        )}

        {filteredOrders.map((o) => {
          const isNew = o.status === 'CREATED';
          return (
            <div
              key={o.id}
              className={`bg-white border rounded-2xl p-6 shadow-sm hover:shadow-md transition-all flex flex-col justify-between ${
                isNew ? 'border-amber-300 ring-2 ring-amber-400/20' : 'border-emerald-300 ring-2 ring-emerald-400/20'
              }`}
            >
              <div>
                {/* Header: Token Number & Status Badge */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block">
                      Token Number
                    </span>
                    <p className="text-4xl font-black text-slate-900 tracking-tight">
                      #{String(o.display_number).padStart(3, '0')}
                    </p>
                  </div>
                  <Badge tone={isNew ? 'warning' : 'success'}>
                    {isNew ? 'New Order' : 'Preparing'}
                  </Badge>
                </div>

                {/* Subheader: Order Number & Type */}
                <p className="text-xs text-slate-500 mb-4 capitalize font-semibold flex items-center gap-2 pb-3 border-b border-slate-100">
                  <span className="font-mono text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                    #{o.order_number}
                  </span>
                  <span>·</span>
                  <span className="text-slate-700">{o.order_type ? o.order_type.replace('_', ' ') : 'Dine-in'}</span>
                </p>

                {/* Items & Quantities List */}
                <div className="mb-6 space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                    Items to Prepare ({o.items?.reduce((acc, i) => acc + i.quantity, 0) || 0}):
                  </p>
                  {o.items && o.items.length > 0 ? (
                    <div className="space-y-1.5">
                      {o.items.map((item, idx) => (
                        <div
                          key={item.id || idx}
                          className="flex items-center justify-between bg-slate-50 border border-slate-200/70 p-2.5 rounded-xl"
                        >
                          <span className="font-bold text-sm text-slate-900">
                            {item.name}
                          </span>
                          <span className="bg-slate-900 text-white font-black text-xs px-2.5 py-1 rounded-lg">
                            Qty: {item.quantity}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400 italic">No item details available</p>
                  )}
                </div>
              </div>

              {/* Action Button */}
              <button
                onClick={() => advance(o)}
                className={`w-full text-white text-sm font-bold py-3.5 rounded-xl shadow-xs transition-all active:scale-[0.99] flex items-center justify-center gap-2 ${
                  isNew
                    ? 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800'
                    : 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800'
                }`}
              >
                {isNew ? (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    START PREPARING
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    MARK READY
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}

