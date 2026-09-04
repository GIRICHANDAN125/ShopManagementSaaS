'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, getToken, clearToken, decodeTokenPayload } from '@/lib/api';

interface Tenant {
  id: string;
  code: string;
  display_name: string;
  business_type?: string | null;
  status: string;
  created_at: string;
  max_employees: number;
  max_counters: number;
  max_customer_displays: number;
  max_printers: number;
  active_employees: number;
  active_counters: number;
  active_displays: number;
  active_printers: number;
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
  const [initMaxEmployees, setInitMaxEmployees] = useState(5);
  const [initMaxCounters, setInitMaxCounters] = useState(1);
  const [initMaxDisplays, setInitMaxDisplays] = useState(1);
  const [initMaxPrinters, setInitMaxPrinters] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<CreatedCredentials | null>(null);
  const [copied, setCopied] = useState(false);

  // Edit limits modal / state
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [editEmployees, setEditEmployees] = useState(5);
  const [editCounters, setEditCounters] = useState(1);
  const [editDisplays, setEditDisplays] = useState(1);
  const [editPrinters, setEditPrinters] = useState(1);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);

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
        maxEmployees: Number(initMaxEmployees) || 5,
        maxCounters: Number(initMaxCounters) || 1,
        maxCustomerDisplays: Number(initMaxDisplays) || 1,
        maxPrinters: Number(initMaxPrinters) || 1,
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
      setInitMaxEmployees(5);
      setInitMaxCounters(1);
      setInitMaxDisplays(1);
      setInitMaxPrinters(1);
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

  function openEditLimits(t: Tenant) {
    setEditingTenant(t);
    setEditEmployees(t.max_employees);
    setEditCounters(t.max_counters);
    setEditDisplays(t.max_customer_displays);
    setEditPrinters(t.max_printers);
    setEditError(null);
  }

  async function saveLimits(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTenant) return;
    setEditError(null);
    setSavingLimits(true);
    try {
      await api.updateTenantLimits(editingTenant.id, {
        maxEmployees: Number(editEmployees),
        maxCounters: Number(editCounters),
        maxCustomerDisplays: Number(editDisplays),
        maxPrinters: Number(editPrinters),
      });
      setEditingTenant(null);
      refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setEditError(message);
    } finally {
      setSavingLimits(false);
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
            <p className="text-sm text-slate-500">
              Provision isolated shops, configure resource limits, and manage initial credentials.
            </p>
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
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white/90 border border-emerald-200 rounded-xl p-4 font-mono text-xs">
              <div>
                <span className="text-slate-400 text-[10px] block uppercase font-sans font-semibold">
                  Shop Code
                </span>
                <span className="font-bold text-slate-900 text-sm">{createdCredentials.shop_code}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[10px] block uppercase font-sans font-semibold">
                  Username
                </span>
                <span className="font-bold text-slate-900 text-sm">{createdCredentials.username}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[10px] block uppercase font-sans font-semibold">
                  Temporary Password
                </span>
                <span className="font-bold text-emerald-700 text-sm">
                  {createdCredentials.temporary_password}
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-slate-500 font-medium">
                Log in at <span className="font-mono text-slate-700">/login</span> using these credentials.
              </span>
              <button
                onClick={copyCredentials}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5 shadow-xs"
              >
                {copied ? '✓ Copied to Clipboard!' : 'Copy Credentials'}
              </button>
            </div>
          </div>
        )}

        {/* Provision Shop Form */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-8 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900 mb-1">Provision New Shop</h2>
          <p className="text-xs text-slate-500 mb-5">
            Initializes an isolated tenant schema, sequence, default roles, and resource limits.
          </p>

          <form onSubmit={createTenant} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Shop Display Name *</label>
                <input
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Giri Bakery"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Business Type</label>
                <input
                  value={businessType}
                  onChange={(e) => setBusinessType(e.target.value)}
                  placeholder="e.g. Bakery / Cafe / Retail"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                />
              </div>
            </div>

            {/* Advanced Configuration Accordion */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((s) => !s)}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
              >
                <span>{showAdvanced ? '▼' : '▶'}</span>
                <span>Advanced configuration (Resource limits & Admin user)</span>
              </button>
            </div>

            {showAdvanced && (
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/50 space-y-4">
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Resource Limits Quota
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Max Employees</label>
                    <input
                      type="number"
                      min={1}
                      value={initMaxEmployees}
                      onChange={(e) => setInitMaxEmployees(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Max Counters</label>
                    <input
                      type="number"
                      min={1}
                      value={initMaxCounters}
                      onChange={(e) => setInitMaxCounters(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Max Displays</label>
                    <input
                      type="number"
                      min={1}
                      value={initMaxDisplays}
                      onChange={(e) => setInitMaxDisplays(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Max Printers</label>
                    <input
                      type="number"
                      min={1}
                      value={initMaxPrinters}
                      onChange={(e) => setInitMaxPrinters(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
                </div>

                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider pt-2 border-t border-slate-200">
                  Initial Admin Account
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Admin Username</label>
                    <input
                      value={adminUsername}
                      onChange={(e) => setAdminUsername(e.target.value)}
                      placeholder="admin"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Admin Display Name</label>
                    <input
                      value={adminDisplayName}
                      onChange={(e) => setAdminDisplayName(e.target.value)}
                      placeholder="Shop Admin"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Custom Password</label>
                    <input
                      type="password"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      placeholder="Leave blank to auto-generate"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs bg-white"
                    />
                  </div>
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

          <div className="space-y-4">
            {tenants.map((t) => (
              <div
                key={t.id}
                className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs hover:border-slate-300 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-slate-900 text-base">{t.display_name}</p>
                      {t.business_type && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                          {t.business_type}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">
                      Code: <span className="font-bold text-slate-800">{t.code}</span> · Created:{' '}
                      {new Date(t.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
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
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
                    >
                      {t.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>

                {/* Resource Limits & Current Usage Grid */}
                <div className="mt-4 p-3.5 bg-slate-50/80 rounded-xl border border-slate-100 flex flex-wrap items-center justify-between gap-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 flex-1">
                    <div>
                      <span className="text-[11px] text-slate-400 font-semibold block uppercase">Employees</span>
                      <span className="font-mono font-bold text-slate-800 text-sm">
                        {t.active_employees} / {t.max_employees}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400 font-semibold block uppercase">Counters</span>
                      <span className="font-mono font-bold text-slate-800 text-sm">
                        {t.active_counters} / {t.max_counters}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400 font-semibold block uppercase">Displays</span>
                      <span className="font-mono font-bold text-slate-800 text-sm">
                        {t.active_displays} / {t.max_customer_displays}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400 font-semibold block uppercase">Printers</span>
                      <span className="font-mono font-bold text-slate-800 text-sm">
                        {t.active_printers} / {t.max_printers}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => openEditLimits(t)}
                    className="text-xs font-bold text-indigo-600 hover:text-indigo-800 bg-white border border-indigo-200 hover:border-indigo-300 px-3.5 py-2 rounded-lg shadow-2xs transition-colors whitespace-nowrap"
                  >
                    Edit Limits
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

        {/* Edit Limits Modal */}
        {editingTenant && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl border border-slate-200">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    Edit Resource Limits
                  </h3>
                  <p className="text-xs text-slate-500">{editingTenant.display_name} ({editingTenant.code})</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingTenant(null)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  ✕
                </button>
              </div>

              {editError && (
                <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs leading-relaxed">
                  {editError}
                </div>
              )}

              <form onSubmit={saveLimits} className="space-y-4">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs font-semibold text-slate-700">Max Employees</label>
                    <span className="text-[11px] text-slate-400">Current active: {editingTenant.active_employees}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={editEmployees}
                    onChange={(e) => setEditEmployees(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm"
                    required
                  />
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs font-semibold text-slate-700">Max Counters</label>
                    <span className="text-[11px] text-slate-400">Current active: {editingTenant.active_counters}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={editCounters}
                    onChange={(e) => setEditCounters(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm"
                    required
                  />
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs font-semibold text-slate-700">Max Customer Displays</label>
                    <span className="text-[11px] text-slate-400">Current active: {editingTenant.active_displays}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={editDisplays}
                    onChange={(e) => setEditDisplays(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm"
                    required
                  />
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs font-semibold text-slate-700">Max Printers</label>
                    <span className="text-[11px] text-slate-400">Current active: {editingTenant.active_printers}</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={editPrinters}
                    onChange={(e) => setEditPrinters(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm"
                    required
                  />
                </div>

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingTenant(null)}
                    className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingLimits}
                    className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-xs transition-colors"
                  >
                    {savingLimits ? 'Saving…' : 'Save Limits'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
