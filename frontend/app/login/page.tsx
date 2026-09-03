'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [shopCode, setShopCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { accessToken } = await api.tenantLogin(shopCode, username, password);
      setToken(accessToken);
      router.push('/counter');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 w-full max-w-sm"
      >
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Shop sign in</h1>
        <p className="text-sm text-slate-500 mb-6">Enter your shop code and staff credentials.</p>

        <label className="block text-sm font-medium text-slate-700 mb-1">Shop code</label>
        <input
          className="w-full mb-4 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          value={shopCode}
          onChange={(e) => setShopCode(e.target.value)}
          placeholder="E2E_SHOP"
          required
        />

        <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
        <input
          className="w-full mb-4 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />

        <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
        <input
          type="password"
          className="w-full mb-6 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && (
          <p className="text-sm text-red-600 mb-4" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-slate-900 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="text-xs text-slate-400 mt-4 text-center">
          Super Admin?{' '}
          <a href="/super-admin/login" className="underline">
            Sign in here
          </a>
        </p>
      </form>
    </main>
  );
}
