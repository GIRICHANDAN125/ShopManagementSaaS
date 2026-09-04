'use client';
import { ReactNode, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { clearToken, getToken, decodeTokenPayload, TokenPayload } from './api';

export function PageShell({
  title,
  subtitle,
  children,
  dark = false,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  dark?: boolean;
  wide?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [userPayload, setUserPayload] = useState<TokenPayload | null>(null);

  useEffect(() => {
    const token = getToken();
    if (token) {
      setUserPayload(decodeTokenPayload(token));
    }
  }, []);

  function logout() {
    clearToken();
    router.push('/login');
  }

  const permissions = userPayload?.permissions || [];
  const isSuperAdmin = !!userPayload?.isSuperAdmin;

  // Determine authorized navigation items
  const navItems = [
    {
      label: 'Counter',
      href: '/counter',
      visible: isSuperAdmin || permissions.includes('order.create') || permissions.includes('*'),
    },
    {
      label: 'Coordinator',
      href: '/coordinator',
      visible: isSuperAdmin || permissions.includes('order.view') || permissions.includes('*'),
    },
    {
      label: 'Kitchen',
      href: '/kitchen',
      visible: isSuperAdmin || permissions.includes('order.view') || permissions.includes('*'),
    },
    {
      label: 'Reports',
      href: '/reports',
      visible: isSuperAdmin || permissions.includes('reports.view') || permissions.includes('*'),
    },
    {
      label: 'Shop Admin',
      href: '/admin',
      visible:
        isSuperAdmin ||
        permissions.includes('shop.settings') ||
        permissions.includes('employee.manage') ||
        permissions.includes('product.manage') ||
        permissions.includes('*'),
    },
    {
      label: 'Customer Display',
      href: '/tv',
      visible: true,
    },
  ].filter((item) => item.visible);

  const isShopAdmin =
    permissions.includes('shop.settings') ||
    permissions.includes('employee.manage') ||
    permissions.includes('product.manage') ||
    permissions.includes('*');

  return (
    <main className={dark ? 'min-h-screen bg-slate-950 text-slate-100' : 'min-h-screen bg-slate-50 text-slate-900'}>
      {/* Top Tenant Navigation Bar */}
      {userPayload && (
        <nav
          className={`border-b ${
            dark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
          } px-6 py-2.5 shadow-sm`}
        >
          <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 sm:gap-2">
              <span
                className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                  isSuperAdmin
                    ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                    : isShopAdmin
                    ? 'bg-purple-100 text-purple-800 border border-purple-200'
                    : 'bg-slate-100 text-slate-700 border border-slate-200'
                }`}
              >
                {isSuperAdmin ? 'Platform Admin' : isShopAdmin ? 'Role: Shop Admin' : 'Role: Staff'}
              </span>

              <div className="flex items-center gap-1 overflow-x-auto ml-2">
                {navItems.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
                        isActive
                          ? dark
                            ? 'bg-slate-800 text-white shadow-sm'
                            : 'bg-slate-900 text-white shadow-sm'
                          : dark
                            ? 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {isSuperAdmin && (
                <Link
                  href="/super-admin"
                  className="text-xs font-semibold text-indigo-600 hover:underline"
                >
                  Super Admin Console →
                </Link>
              )}
              <button
                onClick={logout}
                className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                  dark
                    ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                }`}
              >
                Sign out
              </button>
            </div>
          </div>
        </nav>
      )}

      {/* Main Page Container */}
      <div className={`mx-auto px-6 py-8 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}>
        <header className="flex items-start justify-between mb-8">
          <div>
            <h1
              className={`text-2xl font-bold tracking-tight ${
                dark ? 'text-white' : 'text-slate-900'
              }`}
            >
              {title}
            </h1>
            {subtitle && (
              <p className={`text-sm mt-1 ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
                {subtitle}
              </p>
            )}
          </div>
          {!userPayload && (
            <button
              onClick={logout}
              className={`text-sm font-medium ${
                dark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              Sign out
            </button>
          )}
        </header>
        {children}
      </div>
    </main>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm p-6 ${className}`}>
      {children}
    </div>
  );
}

export function PrimaryButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-slate-900 text-white font-semibold rounded-xl px-5 py-2.5 text-sm hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-white text-slate-700 font-semibold rounded-xl px-5 py-2.5 text-sm border border-slate-300 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent ${props.className ?? ''}`}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="block text-sm font-medium text-slate-700 mb-1.5">{children}</label>;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700',
    success: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-800',
    danger: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-12 text-slate-400 text-sm border border-dashed border-slate-200 rounded-2xl">
      {message}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
      {children}
    </p>
  );
}
