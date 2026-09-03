'use client';
import { api } from './api';

const RESERVATION_KEY = 'shopapp_device_reservation';
const QUEUE_KEY = 'shopapp_offline_queue';
const DEVICE_KEY = 'shopapp_device_id';

export interface CachedReservation {
  id: string;
  rangeStart: number;
  rangeEnd: number;
  nextToIssue: number; // mirrors the server's pointer, advanced locally while offline
}

export interface QueuedOrder {
  localId: string;
  idempotencyKey: string;
  items: { productId: string; quantity: number }[];
  orderType: string;
  deviceId: string;
  reservedOrderNumber: number;
  createdAtDevice: string;
  syncState: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED_RETRYABLE' | 'NEEDS_ATTENTION';
  lastError?: string;
}

export function getDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(DEVICE_KEY);
}

export function setDeviceId(id: string) {
  window.localStorage.setItem(DEVICE_KEY, id);
}

export function getReservation(): CachedReservation | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(RESERVATION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setReservation(r: CachedReservation | null) {
  if (r) window.localStorage.setItem(RESERVATION_KEY, JSON.stringify(r));
  else window.localStorage.removeItem(RESERVATION_KEY);
}

export function getQueue(): QueuedOrder[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(QUEUE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function setQueue(q: QueuedOrder[]) {
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

/** Called while online, well before an outage — requests a fresh block
 * of real order numbers and caches it locally (OFFLINE_SYNC_DESIGN.md §2). */
export async function ensureReservation(deviceId: string, blockSize = 50): Promise<CachedReservation> {
  const existing = getReservation();
  if (existing && existing.nextToIssue <= existing.rangeEnd) return existing;

  const res = await api.reserveRange(deviceId, blockSize);
  const reservation: CachedReservation = {
    id: res.id,
    rangeStart: Number(res.range_start),
    rangeEnd: Number(res.range_end),
    nextToIssue: Number(res.range_start),
  };
  setReservation(reservation);
  return reservation;
}

/**
 * Issues the next number from the LOCAL reservation cache — this is what
 * lets the counter keep working with zero network calls during an
 * outage. Mirrors the server's own next_to_issue advancement logic
 * exactly (DATABASE.md §6) so the two stay consistent once synced.
 * Throws RANGE_EXHAUSTED with no fallback, per OFFLINE_SYNC_DESIGN.md §6
 * — the caller must stop creating orders and show a clear message.
 */
export function issueOfflineNumber(): number {
  const reservation = getReservation();
  if (!reservation || reservation.nextToIssue > reservation.rangeEnd) {
    throw new Error('RANGE_EXHAUSTED: no offline numbers remain — reconnect to continue');
  }
  const number = reservation.nextToIssue;
  setReservation({ ...reservation, nextToIssue: number + 1 });
  return number;
}

export function enqueueOfflineOrder(order: QueuedOrder) {
  setQueue([...getQueue(), order]);
}

/**
 * Drains the local queue against the real backend. Each order retains
 * its original idempotency key from the moment of offline creation, so a
 * retried sync attempt (dropped ack, app restart mid-sync) can never
 * create a duplicate — the server-side UNIQUE(tenant_id, idempotency_key)
 * constraint is the actual correctness boundary, this is just the retry
 * loop around it (OFFLINE_SYNC_DESIGN.md §5, §11).
 */
export async function syncQueue(): Promise<{ synced: number; failed: number }> {
  const queue = getQueue();
  let synced = 0;
  let failed = 0;

  for (const order of queue) {
    if (order.syncState === 'SYNCED') continue;
    try {
      order.syncState = 'SYNCING';
      setQueue(getQueue().map((o) => (o.localId === order.localId ? order : o)));

      await api.syncOfflineOrder({
        idempotencyKey: order.idempotencyKey,
        items: order.items,
        orderType: order.orderType,
        deviceId: order.deviceId,
        reservedOrderNumber: order.reservedOrderNumber,
        createdAtDevice: order.createdAtDevice,
      });

      order.syncState = 'SYNCED';
      synced++;
    } catch (err) {
      // A validation failure (e.g. product deleted while offline) is
      // NEEDS_ATTENTION, not silently retried forever; a network error
      // is FAILED_RETRYABLE and will be retried on the next sync call.
      const isValidationFailure =
        (err as { status?: number }).status === 400 || (err as { status?: number }).status === 409;
      order.syncState = isValidationFailure ? 'NEEDS_ATTENTION' : 'FAILED_RETRYABLE';
      order.lastError = (err as Error).message;
      failed++;
    }
    setQueue(getQueue().map((o) => (o.localId === order.localId ? order : o)));
  }

  return { synced, failed };
}

export function clearSyncedFromQueue() {
  setQueue(getQueue().filter((o) => o.syncState !== 'SYNCED'));
}
