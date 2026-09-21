'use client';
import { useEffect, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import { api, ApiError, getWsBaseUrl } from '@/lib/api';

const DEVICE_TOKEN_KEY = 'shopapp_tv_device_token';
const DEVICE_ID_KEY = 'shopapp_tv_device_id';
const DEVICE_CRED_KEY = 'shopapp_tv_device_credential';

// This screen authenticates as its OWN device identity (SECURITY.md §19),
// obtained once from Shop Admin's device registration, never a staff
// login — the actual approved architecture rather than reusing a staff
// token as an earlier draft of this build did.
export default function CustomerTvPage() {
  const [nowServing, setNowServing] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function connectWithToken(token: string) {
    const socket: Socket = io(getWsBaseUrl(), { auth: { token } });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => {
      // Stored credential no longer valid (revoked/replaced device) —
      // fall back to setup rather than looping silently.
      window.localStorage.removeItem(DEVICE_TOKEN_KEY);
      setNeedsSetup(true);
    });
    socket.on('order.status_changed', (payload: { status: string; displayNumber: number }) => {
      if (payload.status === 'READY') {
        setNowServing(String(payload.displayNumber).padStart(3, '0'));
      }
    });
  }

  useEffect(() => {
    const storedId = window.localStorage.getItem(DEVICE_ID_KEY);
    const storedCred = window.localStorage.getItem(DEVICE_CRED_KEY);
    if (!storedId || !storedCred) {
      setNeedsSetup(true);
      return;
    }
    api
      .deviceConnect(storedId, storedCred)
      .then((res) => connectWithToken(res.token))
      .catch(() => setNeedsSetup(true));
  }, []);

  async function submitSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.deviceConnect(deviceId, credential);
      window.localStorage.setItem(DEVICE_ID_KEY, deviceId);
      window.localStorage.setItem(DEVICE_CRED_KEY, credential);
      setNeedsSetup(false);
      connectWithToken(res.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect this device.');
    }
  }

  if (needsSetup) {
    return (
      <main className="min-h-screen bg-black flex items-center justify-center text-white">
        <form onSubmit={submitSetup} className="bg-slate-900 rounded-2xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-semibold mb-1">Set up this TV</h1>
          <p className="text-sm text-slate-400 mb-6">
            Enter the device ID and credential from Shop Admin → Devices.
          </p>
          <input
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            placeholder="Device ID"
            className="w-full mb-3 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm font-mono"
            required
          />
          <input
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder="Device credential"
            className="w-full mb-4 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm font-mono"
            required
          />
          {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
          <button className="w-full bg-white text-slate-900 rounded-lg py-2.5 text-sm font-semibold">
            Connect
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center text-white">
      <p className="text-2xl tracking-widest text-slate-400 mb-6">NOW SERVING</p>
      <p className="text-[14rem] leading-none font-black tabular-nums">{nowServing ?? '—'}</p>
      <p className="mt-8 text-sm text-slate-500">{connected ? 'Live' : 'Reconnecting…'}</p>
    </main>
  );
}
