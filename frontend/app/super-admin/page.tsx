'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, getToken, clearToken } from '@/lib/api';

interface Tenant {
  id: string;
  code: string;
  display_name: string;
  status: string;
  created_at: string;
}

export default function SuperAdminPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTenants(await api.listTenants());
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError && err.status === 401) router.push('/super-admin/login');
      setError(message);
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/super-admin/login');
      return;
    }
    refresh();
  }, [refresh, router]);

  async function createTenant() {
    if (!displayName) return;
    try {
      await api.createTenant(displayName);
      setDisplayName('');
      refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }

  async function toggleStatus(t: Tenant) {
    await api.setTenantStatus(t.id, t.status === 'active' ? 'inactive' : 'active');
    refresh();
  }

  function logout() {
    clearToken();
    router.push('/super-admin/login');
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Super Admin — Tenants</h1>
          <button onClick={logout} className="text-sm text-slate-500 hover:underline">
            Sign out
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
          <h2 className="font-semibold text-slate-900 mb-3">Create shop</h2>
          <div className="flex gap-3">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Shop display name"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
            />
            <button
              onClick={createTenant}
              className="bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm font-semibold"
            >
              Create
            </button>
          </div>
        </div>

        {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

        <div className="space-y-3">
          {tenants.map((t) => (
            <div
              key={t.id}
              className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between"
            >
              <div>
                <p className="font-semibold text-slate-900">{t.display_name}</p>
                <p className="text-xs text-slate-400 font-mono">{t.code}</p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs font-semibold px-3 py-1 rounded-full ${
                    t.status === 'active'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {t.status}
                </span>
                <button
                  onClick={() => toggleStatus(t)}
                  className="text-sm font-semibold px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50"
                >
                  {t.status === 'active' ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
