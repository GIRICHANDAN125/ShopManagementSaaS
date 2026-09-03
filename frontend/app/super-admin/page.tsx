'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, getToken, clearToken, decodeTokenPayload } from '@/lib/api';

interface Tenant {
  id: string;
  code: string;
  display_name: string;
  status: string;
  created_at: string;
}

interface CreatedCredentials {
  shop_name: string;
  shop_code: string;
  username: string;
  temporary_password: string;
}

export default function SuperAdminPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<CreatedCredentials | null>(null);
  const [copied, setCopied] = useState(false);

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
    const token = getToken();
    if (!token) {
      router.push('/super-admin/login');
      return;
    }
    const payload = decodeTokenPayload(token);
    if (!payload?.isSuperAdmin) {
      router.push('/login');
      return;
    }
    refresh();
  }, [refresh, router]);

  async function createTenant(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.createTenant({
        displayName,
        businessType: businessType || undefined,
        adminUsername: adminUsername || 'admin',
        adminDisplayName: adminDisplayName || `${displayName} Admin`,
        adminPassword: adminPassword || undefined,
      });

      if (res.initial_credentials) {
        setCreatedCredentials({
          shop_name: res.display_name,
          shop_code: res.initial_credentials.shop_code,
          username: res.initial_credentials.username,
          temporary_password: res.initial_credentials.temporary_password,
        });
      }

      setDisplayName('');
      setBusinessType('');
      setAdminUsername('admin');
      setAdminDisplayName('');
      setAdminPassword('');
      setShowAdvanced(false);
      refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function toggleStatus(t: Tenant) {
    try {
      await api.setTenantStatus(t.id, t.status === 'active' ? 'inactive' : 'active');
      refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }

  function copyCredentials() {
    if (!createdCredentials) return;
    const text = `Shop Name: ${createdCredentials.shop_name}\nShop Code: ${createdCredentials.shop_code}\nUsername: ${createdCredentials.username}\nTemporary Password: ${createdCredentials.temporary_password}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  function logout() {
    clearToken();
    router.push('/super-admin/login');
  }

  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-center justify-between mb-8">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
              Platform Super Admin
            </span>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">Tenant & Shop Management</h1>
            <p className="text-sm text-slate-500">Provision isolated shops and initial Shop Admin credentials.</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/login')}
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 px-3 py-1.5 rounded-lg"
            >
              Shop Login →
            </button>
            <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-800">
              Sign out
            </button>
          </div>
        </header>

        {/* Credentials Modal / Banner */}
        {createdCredentials && (
          <div className="bg-emerald-50 border-2 border-emerald-300 rounded-2xl p-6 mb-8 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-800 bg-emerald-200/70 px-2.5 py-1 rounded-full mb-2">
                  ✓ Shop & Initial Shop Admin Provisioned
                </span>
                <h2 className="text-lg font-bold text-emerald-950">
                  {createdCredentials.shop_name} — Initial Credentials
                </h2>
                <p className="text-xs text-amber-800 mt-0.5 font-medium">
                  ⚠️ Sensitive: These credentials are shown only once. Securely save them now.
                </p>
              </div>
              <button
                onClick={() => setCreatedCredentials(null)}
                className="text-slate-400 hover:text-slate-700 text-sm font-semibold"
              >
                Dismiss ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-4 bg-white/80 backdrop-blur rounded-xl p-4 border border-emerald-200">
              <div>
                <span className="text-xs text-slate-500 block">Shop Code</span>
                <span className="font-mono text-sm font-bold text-slate-900 select-all">
                  {createdCredentials.shop_code}
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-500 block">Admin Username</span>
                <span className="font-mono text-sm font-bold text-slate-900 select-all">
                  {createdCredentials.username}
                </span>
              </div>
              <div>
                <span className="text-xs text-slate-500 block">Temporary Password</span>
                <span className="font-mono text-sm font-bold text-emerald-700 bg-emerald-100/50 px-2 py-0.5 rounded select-all">
                  {createdCredentials.temporary_password}
                </span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={copyCredentials}
                className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                {copied ? 'Copied to Clipboard ✓' : 'Copy Credentials'}
              </button>
              <button
                onClick={() => router.push('/login')}
                className="bg-white text-slate-700 hover:bg-slate-100 border border-slate-300 text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                Go to Shop Sign In →
              </button>
            </div>
          </div>
        )}

        {/* Create Shop Form */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-8 shadow-sm">
          <h2 className="font-semibold text-slate-900 mb-1">Create new shop</h2>
          <p className="text-xs text-slate-500 mb-4">
            Provisions an isolated PostgreSQL sequence, tenant-scoped roles (Shop Admin, Counter, Kitchen, Coordinator), and the initial Shop Admin account.
          </p>

          <form onSubmit={createTenant} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Shop Display Name <span className="text-red-500">*</span>
                </label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Test Coffee Shop"
                  required
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Business Type</label>
                <input
                  value={businessType}
                  onChange={(e) => setBusinessType(e.target.value)}
                  placeholder="e.g. Cafe / Bakery / Quick Service"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-xs font-semibold text-indigo-600 hover:underline inline-flex items-center gap-1"
              >
                {showAdvanced ? '− Hide Admin Account Options' : '+ Custom Admin Username & Password'}
              </button>
            </div>

            {showAdvanced && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Admin Username</label>
                  <input
                    value={adminUsername}
                    onChange={(e) => setAdminUsername(e.target.value)}
                    placeholder="admin"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Admin Display Name</label>
                  <input
                    value={adminDisplayName}
                    onChange={(e) => setAdminDisplayName(e.target.value)}
                    placeholder="Shop Admin"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Custom Password <span className="text-slate-400 font-normal">(leave blank to auto-generate)</span>
                  </label>
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={loading || !displayName}
                className="bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white px-6 py-2.5 rounded-xl text-sm font-semibold transition-colors"
              >
                {loading ? 'Creating & Provisioning…' : 'Create Shop & Admin'}
              </button>
            </div>
          </form>
        </div>

        {/* Existing Tenants */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">Registered Shops ({tenants.length})</h2>
            <button onClick={refresh} className="text-xs text-slate-500 hover:underline">
              Refresh
            </button>
          </div>

          <div className="space-y-3">
            {tenants.map((t) => (
              <div
                key={t.id}
                className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between shadow-sm hover:border-slate-300 transition-colors"
              >
                <div>
                  <p className="font-semibold text-slate-900">{t.display_name}</p>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">
                    Code: <span className="font-bold text-slate-800">{t.code}</span> · Created:{' '}
                    {new Date(t.created_at).toLocaleDateString()}
                  </p>
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
                    className="text-xs font-semibold px-3.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
                  >
                    {t.status === 'active' ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            ))}

            {tenants.length === 0 && (
              <div className="text-center py-12 text-slate-400 text-sm border border-dashed border-slate-200 rounded-2xl bg-white">
                No shops registered yet. Use the form above to create the first shop.
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
