'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, setToken, getToken, decodeTokenPayload } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [shopCode, setShopCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [mustChangePasswordMode, setMustChangePasswordMode] = useState(false);
  const [currentPassForChange, setCurrentPassForChange] = useState('');
  const [newPassForChange, setNewPassForChange] = useState('');
  const [confirmPassForChange, setConfirmPassForChange] = useState('');
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changingPass, setChangingPass] = useState(false);

  function navigateToRoleHome(token: string) {
    const payload = decodeTokenPayload(token);
    const perms = payload?.permissions || [];
    if (
      perms.includes('shop.settings') ||
      perms.includes('employee.manage') ||
      perms.includes('product.manage') ||
      perms.includes('*')
    ) {
      router.push('/admin');
    } else if (perms.includes('order.create')) {
      router.push('/counter');
    } else if (perms.includes('order.view')) {
      router.push('/kitchen');
    } else if (perms.includes('reports.view')) {
      router.push('/reports');
    } else {
      router.push('/counter');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.tenantLogin(shopCode.trim(), username.trim(), password);
      const accessToken = res.accessToken;
      window.localStorage.setItem('shopapp_username', username);
      setToken(accessToken);
      const payload = decodeTokenPayload(accessToken);

      if (res.user?.mustChangePassword || payload?.mustChangePassword) {
        setMustChangePasswordMode(true);
        setCurrentPassForChange(password);
        setLoading(false);
        return;
      }

      navigateToRoleHome(accessToken);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordChangeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChangeError(null);

    if (newPassForChange.length < 6) {
      setChangeError('New password must be at least 6 characters long.');
      return;
    }
    if (newPassForChange !== confirmPassForChange) {
      setChangeError('New passwords do not match.');
      return;
    }
    if (newPassForChange === currentPassForChange) {
      setChangeError('New password must be different from current temporary password.');
      return;
    }

    setChangingPass(true);
    try {
      const changeRes = await api.changePassword(currentPassForChange, newPassForChange);
      if (changeRes.accessToken) {
        setToken(changeRes.accessToken);
        navigateToRoleHome(changeRes.accessToken);
      } else {
        const token = getToken();
        if (token) navigateToRoleHome(token);
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setChangeError(message ?? 'Failed to update password');
    } finally {
      setChangingPass(false);
    }
  }

  if (mustChangePasswordMode) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <form
          onSubmit={handlePasswordChangeSubmit}
          className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 w-full max-w-md"
        >
          <div className="mb-6">
            <span className="inline-block text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 px-2.5 py-1 rounded-full mb-2">
              Action Required · First Login
            </span>
            <h1 className="text-xl font-bold text-slate-900">Change Temporary Password</h1>
            <p className="text-xs text-slate-500 mt-1">
              You are signed in with a temporary password from Super Admin. Please set a new permanent password to secure your account before continuing.
            </p>
          </div>

          <label className="block text-xs font-semibold text-slate-700 mb-1">Temporary Password</label>
          <input
            type="password"
            className="w-full mb-4 rounded-xl border border-slate-300 px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 font-mono"
            value={currentPassForChange}
            onChange={(e) => setCurrentPassForChange(e.target.value)}
            placeholder="Enter current temporary password"
            required
          />

          <label className="block text-xs font-semibold text-slate-700 mb-1">New Password</label>
          <input
            type="password"
            className="w-full mb-4 rounded-xl border border-slate-300 px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 font-mono"
            value={newPassForChange}
            onChange={(e) => setNewPassForChange(e.target.value)}
            placeholder="At least 6 characters"
            required
            minLength={6}
          />

          <label className="block text-xs font-semibold text-slate-700 mb-1">Confirm New Password</label>
          <input
            type="password"
            className="w-full mb-6 rounded-xl border border-slate-300 px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 font-mono"
            value={confirmPassForChange}
            onChange={(e) => setConfirmPassForChange(e.target.value)}
            placeholder="Re-enter new password"
            required
            minLength={6}
          />

          {changeError && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3 mb-4">
              {changeError}
            </div>
          )}

          <button
            type="submit"
            disabled={changingPass}
            className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {changingPass ? 'Updating Password…' : 'Set Permanent Password & Continue'}
          </button>
        </form>
      </main>
    );
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
