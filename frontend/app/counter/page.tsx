'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, decodeTokenPayload } from '@/lib/api';
import {
  ensureReservation,
  issueOfflineNumber,
  enqueueOfflineOrder,
  syncQueue,
  getQueue,
  getDeviceId,
  setDeviceId,
  getReservation,
} from '@/lib/offline-queue';
import { PageShell, Card, PrimaryButton, SecondaryButton, Label, Badge, ErrorText } from '@/lib/ui';

interface Product {
  id: string;
  name: string;
  price: string;
  category_name: string | null;
}

interface Receipt {
  orderNumber: string;
  displayNumber: number;
  total: string;
  status: string;
  offline?: boolean;
}

export default function CounterPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<{ productId: string; quantity: number; name: string; price: number }[]>([]);
  const [orderType, setOrderType] = useState('dine_in');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [remainingOffline, setRemainingOffline] = useState<number | null>(null);
  const [deviceSetupNeeded, setDeviceSetupNeeded] = useState(false);

  const refreshQueueStatus = useCallback(() => {
    setQueueCount(getQueue().filter((o) => o.syncState !== 'SYNCED').length);
    const reservation = getReservation();
    setRemainingOffline(reservation ? reservation.rangeEnd - reservation.nextToIssue + 1 : null);
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.push('/login');
      return;
    }
    const payload = decodeTokenPayload(token);
    if (payload?.isSuperAdmin) {
      router.push('/super-admin');
      return;
    }
    if (!getDeviceId()) setDeviceSetupNeeded(true);

    api.listProducts().then(setProducts).catch((e) => setError(e.message));
    refreshQueueStatus();

    setIsOnline(navigator.onLine);
    const goOnline = async () => {
      setIsOnline(true);
      const { synced, failed } = await syncQueue();
      refreshQueueStatus();
      if (synced > 0) setError(null);
      if (failed > 0) setError(`${failed} offline order(s) could not sync — see queue status.`);
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [router, refreshQueueStatus]);

  async function setupDevice() {
    try {
      const res = await api.registerDevice(`Counter-${Date.now()}`);
      setDeviceId(res.device.id);
      await ensureReservation(res.device.id, 50);
      setDeviceSetupNeeded(false);
      refreshQueueStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function addToCart(p: Product) {
    setCart((c) => {
      const existing = c.find((i) => i.productId === p.id);
      if (existing) {
        return c.map((i) => (i.productId === p.id ? { ...i, quantity: i.quantity + 1 } : i));
      }
      return [...c, { productId: p.id, quantity: 1, name: p.name, price: Number(p.price) }];
    });
  }

  async function submitOrder() {
    if (cart.length === 0) return;
    setSubmitting(true);
    setError(null);
    const items = cart.map((i) => ({ productId: i.productId, quantity: i.quantity }));
    const idempotencyKey = crypto.randomUUID();

    try {
      if (isOnline) {
        const order = await api.createOrder({ idempotencyKey, items, orderType });
        setReceipt({ ...order, offline: false });
      } else {
        // OFFLINE PATH — no network call at all for the number itself.
        // A number is drawn from the pre-reserved local block and the
        // receipt is FINAL immediately (OFFLINE_SYNC_DESIGN.md §3) — not
        // provisional, never renumbered later.
        const deviceId = getDeviceId();
        if (!deviceId) throw new Error('Device not set up — cannot operate offline.');
        const reservedOrderNumber = issueOfflineNumber(); // throws RANGE_EXHAUSTED if depleted
        const displayNumber = ((reservedOrderNumber - 1) % 999) + 1;
        const createdAtDevice = new Date().toISOString();
        enqueueOfflineOrder({
          localId: crypto.randomUUID(),
          idempotencyKey,
          items,
          orderType,
          deviceId,
          reservedOrderNumber,
          createdAtDevice,
          syncState: 'PENDING',
        });
        setReceipt({
          orderNumber: String(reservedOrderNumber),
          displayNumber,
          total: cart.reduce((s, i) => s + i.price * i.quantity, 0).toFixed(2),
          status: 'CREATED (offline)',
          offline: true,
        });
      }
      setCart([]);
      refreshQueueStatus();
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith('RANGE_EXHAUSTED')) {
        setError(
          'Offline order-number range is exhausted. Reconnect to the internet to obtain a new reservation before creating more orders.',
        );
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageShell title="Counter" subtitle="Select items, confirm, and print." wide>
      <div className="flex items-center gap-3 mb-6">
        <Badge tone={isOnline ? 'success' : 'warning'}>{isOnline ? 'Online' : 'Offline mode'}</Badge>
        {queueCount > 0 && <Badge tone="neutral">{queueCount} order(s) queued to sync</Badge>}
        {!isOnline && remainingOffline !== null && (
          <Badge tone={remainingOffline <= 5 ? 'danger' : 'neutral'}>
            {remainingOffline} offline number(s) remaining
          </Badge>
        )}
      </div>

      {deviceSetupNeeded && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-900 mb-3">
            This counter isn&rsquo;t set up for offline resilience yet. Set it up now while online.
          </p>
          <SecondaryButton onClick={setupDevice}>Set up this counter device</SecondaryButton>
        </Card>
      )}

      <ErrorText>{error}</ErrorText>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <h2 className="font-semibold text-slate-900 mb-4">Products</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => addToCart(p)}
                className="text-left border border-slate-200 rounded-xl p-4 hover:border-slate-900 hover:shadow-sm transition-all"
              >
                <p className="font-semibold text-slate-900 text-sm">{p.name}</p>
                <p className="text-xs text-slate-400 mb-1">{p.category_name ?? 'Uncategorized'}</p>
                <p className="text-sm font-bold text-slate-900">₹{p.price}</p>
              </button>
            ))}
            {products.length === 0 && (
              <p className="text-sm text-slate-400 col-span-full">
                No products yet — add some from Shop Admin.
              </p>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <Label>Order type</Label>
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value)}
              className="w-full mb-4 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
            >
              <option value="dine_in">Dine-in</option>
              <option value="takeaway">Takeaway</option>
              <option value="pickup">Pickup</option>
            </select>

            <h3 className="text-sm font-semibold text-slate-700 mb-2">
              Cart ({cart.length} item{cart.length === 1 ? '' : 's'})
            </h3>
            <ul className="mb-4 space-y-1 max-h-40 overflow-y-auto">
              {cart.map((i) => (
                <li key={i.productId} className="text-sm text-slate-600 flex justify-between">
                  <span>{i.quantity} × {i.name}</span>
                  <span>₹{(i.price * i.quantity).toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <PrimaryButton
              onClick={submitOrder}
              disabled={cart.length === 0 || submitting}
              className="w-full py-3.5 text-base"
            >
              {submitting ? 'Submitting…' : 'Confirm & Print'}
            </PrimaryButton>
          </Card>

          <Card>
            <h2 className="font-semibold text-slate-900 mb-3">Last receipt</h2>
            {!receipt ? (
              <p className="text-sm text-slate-400">No order yet this session.</p>
            ) : (
              <div className="font-mono text-sm border border-dashed border-slate-300 rounded-xl p-4">
                <p>Order No: {receipt.orderNumber}</p>
                <p className="text-3xl font-bold my-2">
                  Token: {String(receipt.displayNumber).padStart(3, '0')}
                </p>
                <p>Total: ₹{receipt.total}</p>
                <p>{receipt.offline ? 'Printed offline — final' : receipt.status}</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
