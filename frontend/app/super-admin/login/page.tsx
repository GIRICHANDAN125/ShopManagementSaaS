'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, setToken } from '@/lib/api';

export default function SuperAdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { accessToken } = await api.superAdminLogin(username, password);
      setToken(accessToken);
      router.push('/super-admin');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message ?? 'Login failed');
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-sm p-8 w-full max-w-sm"
      >
        <h1 className="text-xl font-semibold text-slate-900 mb-6">Super Admin sign in</h1>
        <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
        <input
          className="w-full mb-4 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
        <input
          type="password"
          className="w-full mb-6 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
        <button className="w-full bg-slate-900 text-white rounded-lg py-2.5 text-sm font-medium">
          Sign in
        </button>
      </form>
    </main>
  );
}
