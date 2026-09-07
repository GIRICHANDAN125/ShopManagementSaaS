'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
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
import { PageShell, Card, SecondaryButton, Badge, ErrorText } from '@/lib/ui';

interface Product {
  id: string;
  name: string;
  price: string;
  category_id?: string | null;
  category_name: string | null;
  image_url?: string | null;
}

interface Category {
  id: string;
  name: string;
}

interface PackingConfig {
  rule: 'none' | 'flat' | 'per_item';
  flatCharge?: number;
  perItemCharge?: number;
}

interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  categoryName?: string | null;
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [packingConfig, setPackingConfig] = useState<PackingConfig>({ rule: 'none' });
  const [cart, setCart] = useState<CartItem[]>([]);
  const [orderType, setOrderType] = useState('dine_in');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [remainingOffline, setRemainingOffline] = useState<number | null>(null);
  const [deviceSetupNeeded, setDeviceSetupNeeded] = useState(false);
  const [counterInfo, setCounterInfo] = useState<{ name: string; code: string }>({
    name: 'Counter 01',
    code: 'CTR-01',
  });
  const [operatorName, setOperatorName] = useState<string>('Staff');
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function handleFullscreenChange() {
      const isCurrentlyFullscreen = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
          (document as unknown as { mozFullScreenElement?: Element }).mozFullScreenElement ||
          (document as unknown as { msFullscreenElement?: Element }).msFullscreenElement,
      );
      setIsFullscreen(isCurrentlyFullscreen);
    }

    function handleFullscreenError() {
      setError('An error occurred while attempting to toggle full screen.');
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    document.addEventListener('fullscreenerror', handleFullscreenError);
    document.addEventListener('webkitfullscreenerror', handleFullscreenError);
    document.addEventListener('mozfullscreenerror', handleFullscreenError);
    document.addEventListener('MSFullscreenError', handleFullscreenError);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);

      document.removeEventListener('fullscreenerror', handleFullscreenError);
      document.removeEventListener('webkitfullscreenerror', handleFullscreenError);
      document.removeEventListener('mozfullscreenerror', handleFullscreenError);
      document.removeEventListener('MSFullscreenError', handleFullscreenError);
    };
  }, []);

  async function toggleFullscreen() {
    try {
      const doc = document as unknown as {
        fullscreenElement?: Element;
        webkitFullscreenElement?: Element;
        mozFullScreenElement?: Element;
        msFullscreenElement?: Element;
        exitFullscreen?: () => Promise<void>;
        webkitExitFullscreen?: () => Promise<void>;
        mozCancelFullScreen?: () => Promise<void>;
        msExitFullscreen?: () => Promise<void>;
        fullscreenEnabled?: boolean;
        webkitFullscreenEnabled?: boolean;
        mozFullScreenEnabled?: boolean;
        msFullscreenEnabled?: boolean;
      };

      const isFsEnabled =
        doc.fullscreenEnabled ??
        doc.webkitFullscreenEnabled ??
        doc.mozFullScreenEnabled ??
        doc.msFullscreenEnabled ??
        true;

      if (!isFsEnabled) {
        setError('Full screen mode is disabled or not supported by your browser.');
        return;
      }

      const activeFsEl =
        doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement;

      if (activeFsEl) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        } else if (doc.mozCancelFullScreen) {
          await doc.mozCancelFullScreen();
        } else if (doc.msExitFullscreen) {
          await doc.msExitFullscreen();
        }
      } else {
        const elem = document.documentElement as HTMLElement & {
          webkitRequestFullscreen?: () => Promise<void>;
          mozRequestFullScreen?: () => Promise<void>;
          msRequestFullscreen?: () => Promise<void>;
        };
        if (elem.requestFullscreen) {
          await elem.requestFullscreen();
        } else if (elem.webkitRequestFullscreen) {
          await elem.webkitRequestFullscreen();
        } else if (elem.mozRequestFullScreen) {
          await elem.mozRequestFullScreen();
        } else if (elem.msRequestFullscreen) {
          await elem.msRequestFullscreen();
        } else {
          setError('Full screen mode is not supported by your browser.');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Full screen request failed: ${msg}`);
    }
  }

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

    // Operator and counter setup
    if (payload?.sub) {
      setOperatorName(window.localStorage.getItem('shopapp_username') || 'Staff');
    }
    const storedActive = window.sessionStorage.getItem('shopapp_active_counter');
    if (storedActive) {
      try {
        setCounterInfo(JSON.parse(storedActive));
      } catch {}
    } else {
      api.getAssignedCounter().then((ac) => {
        if (ac) setCounterInfo({ name: ac.name, code: ac.code });
      }).catch(() => {});
    }

    api.listProducts().then(setProducts).catch((e) => setError(e.message));
    api.listCategories().then(setCategories).catch(() => {});
    api.getPackingConfig().then((cfg) => {
      if (cfg && cfg.rule) setPackingConfig(cfg);
    }).catch(() => {});

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

  // Cart operations
  function addToCart(p: Product) {
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === p.id);
      if (existing) {
        return prev.map((i) =>
          i.productId === p.id ? { ...i, quantity: i.quantity + 1 } : i,
        );
      }
      return [
        ...prev,
        {
          productId: p.id,
          name: p.name,
          price: Number(p.price),
          quantity: 1,
          categoryName: p.category_name,
        },
      ];
    });
  }

  function decreaseQuantity(productId: string) {
    setCart((prev) =>
      prev
        .map((i) => (i.productId === productId ? { ...i, quantity: i.quantity - 1 } : i))
        .filter((i) => i.quantity > 0),
    );
  }

  function increaseQuantity(productId: string) {
    setCart((prev) =>
      prev.map((i) => (i.productId === productId ? { ...i, quantity: i.quantity + 1 } : i)),
    );
  }

  function removeFromCart(productId: string) {
    setCart((prev) => prev.filter((i) => i.productId !== productId));
  }

  function clearCart() {
    setCart([]);
  }

  // Calculation logic matching backend
  const subtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }, [cart]);

  const packingCharge = useMemo(() => {
    if (cart.length === 0) return 0;
    if (packingConfig.rule === 'flat') {
      return Number(packingConfig.flatCharge ?? 0);
    }
    if (packingConfig.rule === 'per_item') {
      return Number(packingConfig.perItemCharge ?? 0) * cart.length;
    }
    return 0;
  }, [cart, packingConfig]);

  const total = useMemo(() => {
    return subtotal + packingCharge;
  }, [subtotal, packingCharge]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return products.filter((p) => {
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.category_name && p.category_name.toLowerCase().includes(q));
      const matchesCategory =
        selectedCategory === 'all' ||
        p.category_name === selectedCategory ||
        p.category_id === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [products, searchQuery, selectedCategory]);

  async function submitOrder() {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    const items = cart.map((i) => ({ productId: i.productId, quantity: i.quantity }));
    const idempotencyKey = crypto.randomUUID();

    try {
      if (isOnline) {
        const order = await api.createOrder({ idempotencyKey, items, orderType });
        setReceipt({ ...order, offline: false });
      } else {
        const deviceId = getDeviceId();
        if (!deviceId) throw new Error('Device not set up — cannot operate offline.');
        const reservedOrderNumber = issueOfflineNumber();
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
          total: total.toFixed(2),
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
    <PageShell title="Counter POS" subtitle="Select products, build orders, and print receipts." wide>
      {/* Top Status Indicators */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge tone="neutral">
            <span className="font-bold text-slate-700 mr-1">Counter:</span>
            {counterInfo.name} ({counterInfo.code})
          </Badge>
          <Badge tone="neutral">
            <span className="font-bold text-slate-700 mr-1">Operator:</span>
            {operatorName}
          </Badge>
          <Badge tone={isOnline ? 'success' : 'warning'}>
            <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${isOnline ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {isOnline ? 'Online' : 'Offline mode'}
          </Badge>
          {queueCount > 0 && <Badge tone="neutral">{queueCount} order(s) queued to sync</Badge>}
          {!isOnline && remainingOffline !== null && (
            <Badge tone={remainingOffline <= 5 ? 'danger' : 'neutral'}>
              {remainingOffline} offline number(s) remaining
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <SecondaryButton
            type="button"
            onClick={toggleFullscreen}
            className="!py-1.5 !px-3 text-xs flex items-center gap-1.5 border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors shadow-xs"
            title={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'}
          >
            {isFullscreen ? (
              <>
                <svg className="w-3.5 h-3.5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9L4 4m0 0h5m-5 0v5m6 6l5 5m0 0h-5m5 0v-5M9 15l-5 5m0 0h5m-5 0v-5m11-6l5-5m0 0h-5m5 0v5" />
                </svg>
                Exit Full Screen
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5h-4m4 0v-4m0 4l-5-5" />
                </svg>
                Full Screen
              </>
            )}
          </SecondaryButton>
        </div>
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

      {/* TOP CONTROLS: Search, Category Filter, Order Type */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm mb-6">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5 items-center">
          {/* 1. Product Search */}
          <div className="md:col-span-5 relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-slate-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search products..."
              className="w-full pl-10 pr-9 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* 2. Category Filter */}
          <div className="md:col-span-4">
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white transition-colors"
            >
              <option value="all">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* 3. Order Type Selector */}
          <div className="md:col-span-3">
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-900 text-white font-semibold rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-700 transition-colors shadow-sm"
            >
              <option value="dine_in">Dine-in</option>
              <option value="takeaway">Takeaway</option>
              <option value="delivery">Delivery</option>
            </select>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT: Responsive Two Columns (Desktop: ~58% Products, ~42% Order) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT SIDE: PRODUCTS SECTION (approx 58% on desktop) */}
        <section className="lg:col-span-7 xl:col-span-7">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-slate-900 text-base tracking-tight flex items-center gap-2">
                Products
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                  {filteredProducts.length}
                </span>
              </h2>
              {(searchQuery || selectedCategory !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategory('all');
                  }}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold"
                >
                  Reset filters
                </button>
              )}
            </div>

            {/* Products Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
              {filteredProducts.map((p) => {
                const hasImage = !!p.image_url;
                const imageUrl = hasImage ? api.getProductImageUrl(p.id) : null;
                const inCart = cart.find((i) => i.productId === p.id);

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addToCart(p)}
                    className={`group text-left border rounded-xl p-3 transition-all relative flex flex-col justify-between overflow-hidden ${
                      inCart
                        ? 'border-indigo-600 bg-indigo-50/20 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-400 hover:shadow-sm'
                    }`}
                  >
                    {/* In-cart Quantity Badge */}
                    {inCart && (
                      <div className="absolute top-2 right-2 z-10 bg-indigo-600 text-white text-xs font-bold px-2 py-0.5 rounded-full shadow-sm">
                        {inCart.quantity} in cart
                      </div>
                    )}

                    {/* Product Image Container */}
                    <div className="w-full aspect-[4/3] rounded-lg bg-slate-100 overflow-hidden mb-2.5 relative border border-slate-100 flex items-center justify-center">
                      {hasImage && imageUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={imageUrl}
                          alt={p.name}
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                            const fallback = e.currentTarget.parentElement?.querySelector('.fallback-placeholder');
                            if (fallback) fallback.classList.remove('hidden');
                          }}
                        />
                      ) : null}

                      {/* Clean Modern Placeholder Icon */}
                      <div className={`fallback-placeholder flex flex-col items-center justify-center text-slate-300 ${hasImage ? 'hidden' : ''}`}>
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                        <span className="text-[10px] font-medium text-slate-400 mt-1">No Image</span>
                      </div>
                    </div>

                    {/* Details */}
                    <div>
                      <p className="text-xs font-medium text-slate-400 truncate mb-0.5">
                        {p.category_name ?? 'Uncategorized'}
                      </p>
                      <h3 className="font-bold text-slate-900 text-sm leading-tight line-clamp-2 mb-1.5 group-hover:text-indigo-600 transition-colors">
                        {p.name}
                      </h3>
                      <p className="text-base font-extrabold text-slate-900">
                        ₹{Number(p.price).toFixed(2)}
                      </p>
                    </div>
                  </button>
                );
              })}

              {filteredProducts.length === 0 && (
                <div className="col-span-full py-12 text-center text-slate-400 bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
                  <svg className="w-10 h-10 mx-auto text-slate-300 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                  </svg>
                  <p className="text-sm font-semibold text-slate-600">No products found</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {searchQuery || selectedCategory !== 'all'
                      ? 'Try clearing your search query or selecting a different category.'
                      : 'No products available yet. Add products from Shop Admin.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT SIDE: CURRENT ORDER & RECEIPT (approx 42% on desktop) */}
        <section className="lg:col-span-5 xl:col-span-5 space-y-6">
          {/* CURRENT ORDER PANEL */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between pb-3.5 mb-3.5 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-slate-900 text-base tracking-tight uppercase">
                  Current Order
                </h2>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-900 text-white">
                  {cart.reduce((s, i) => s + i.quantity, 0)}
                </span>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-xs text-slate-400 hover:text-rose-600 font-medium transition-colors"
                >
                  Clear Cart
                </button>
              )}
            </div>

            {/* Cart Line Items */}
            <div className="max-h-[380px] overflow-y-auto space-y-3 pr-1">
              {cart.map((item) => (
                <div
                  key={item.productId}
                  className="p-3 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900 text-sm truncate leading-tight">
                        {item.name}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        ₹{item.price.toFixed(2)} each
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromCart(item.productId)}
                      className="text-slate-400 hover:text-rose-600 p-1 rounded-md transition-colors"
                      title="Remove item"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Quantity Controls & Line Total Calculation */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200/60">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => decreaseQuantity(item.productId)}
                        className="w-7 h-7 rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 active:scale-95 flex items-center justify-center font-bold text-sm shadow-xs transition-transform"
                        title="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="w-7 text-center font-extrabold text-sm text-slate-900">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => increaseQuantity(item.productId)}
                        className="w-7 h-7 rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 active:scale-95 flex items-center justify-center font-bold text-sm shadow-xs transition-transform"
                        title="Increase quantity"
                      >
                        +
                      </button>
                    </div>

                    {/* Visible Line Calculation: ₹200 × 2 = ₹400 */}
                    <div className="text-right font-mono text-xs text-slate-600">
                      <span className="text-slate-400">
                        ₹{item.price.toFixed(2)} × {item.quantity} ={' '}
                      </span>
                      <span className="font-bold text-slate-900 text-sm">
                        ₹{(item.price * item.quantity).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {cart.length === 0 && (
                <div className="py-12 text-center text-slate-400">
                  <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-300 mx-auto flex items-center justify-center mb-3">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
                    </svg>
                  </div>
                  <p className="text-sm font-semibold text-slate-700">Your cart is empty</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-[200px] mx-auto">
                    Click any product card on the left to add items to this order.
                  </p>
                </div>
              )}
            </div>

            {/* CART TOTALS SECTION */}
            <div className="mt-5 pt-4 border-t border-slate-200 space-y-2.5">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal</span>
                <span className="font-semibold text-slate-800">₹{subtotal.toFixed(2)}</span>
              </div>

              <div className="flex justify-between text-sm text-slate-600">
                <span>
                  Packing Charge
                  {packingConfig.rule !== 'none' && cart.length > 0 && (
                    <span className="text-xs text-slate-400 ml-1.5">
                      ({packingConfig.rule === 'flat' ? 'Flat' : 'Per Item'})
                    </span>
                  )}
                </span>
                <span className="font-semibold text-slate-800">₹{packingCharge.toFixed(2)}</span>
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-between items-baseline">
                <span className="text-base font-extrabold text-slate-900 tracking-tight">TOTAL</span>
                <span className="text-2xl font-black text-slate-900 tracking-tight">
                  ₹{total.toFixed(2)}
                </span>
              </div>

              {/* CONFIRM ORDER BUTTON */}
              <button
                type="button"
                onClick={submitOrder}
                disabled={cart.length === 0 || submitting}
                className="w-full mt-3 py-3.5 px-4 rounded-xl text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Creating Order…</span>
                  </>
                ) : (
                  <span>CONFIRM ORDER</span>
                )}
              </button>
            </div>
          </div>

          {/* LAST RECEIPT SECTION */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h2 className="font-bold text-slate-900 text-sm tracking-tight mb-3 flex items-center justify-between">
              <span>Last Receipt</span>
              {receipt?.offline && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                  OFFLINE
                </span>
              )}
            </h2>

            {!receipt ? (
              <p className="text-xs text-slate-400 italic">No order confirmed in this session yet.</p>
            ) : (
              <div className="font-mono text-xs bg-slate-50 border border-dashed border-slate-300 rounded-xl p-4 space-y-2">
                <div className="flex justify-between text-slate-500">
                  <span>Order No:</span>
                  <span className="font-bold text-slate-800">{receipt.orderNumber}</span>
                </div>
                <div className="text-center py-2 bg-white rounded-lg border border-slate-200 shadow-xs">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block font-sans font-semibold">Token Number</span>
                  <p className="text-3xl font-black text-slate-900 my-0.5">
                    {String(receipt.displayNumber).padStart(3, '0')}
                  </p>
                </div>
                <div className="flex justify-between text-slate-500 pt-1">
                  <span>Total Amount:</span>
                  <span className="font-bold text-slate-900">₹{receipt.total}</span>
                </div>
                <div className="flex justify-between text-slate-500">
                  <span>Status:</span>
                  <span className="font-bold text-emerald-600">{receipt.status}</span>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </PageShell>
  );
}
