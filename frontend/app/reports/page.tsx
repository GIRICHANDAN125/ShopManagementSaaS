'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, ApiError } from '@/lib/api';
import { PageShell, Card, ErrorText } from '@/lib/ui';

interface Summary {
  total_orders: string;
  completed_orders: string;
  cancelled_orders: string;
  revenue: string;
  average_order_value?: string;
}

function SummaryCard({ title, data }: { title: string; data: Summary | null }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-500 mb-4">{title}</h3>
      {!data ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <dl className="grid grid-cols-2 gap-y-3 text-sm">
          <dt className="text-slate-500">Total orders</dt>
          <dd className="text-right font-semibold text-slate-900">{data.total_orders}</dd>
          <dt className="text-slate-500">Completed</dt>
          <dd className="text-right font-semibold text-slate-900">{data.completed_orders}</dd>
          <dt className="text-slate-500">Cancelled</dt>
          <dd className="text-right font-semibold text-slate-900">{data.cancelled_orders}</dd>
          <dt className="text-slate-500">Revenue</dt>
          <dd className="text-right font-bold text-slate-900">₹{Number(data.revenue).toFixed(2)}</dd>
        </dl>
      )}
    </Card>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const [today, setToday] = useState<Summary | null>(null);
  const [previousDay, setPreviousDay] = useState<Summary | null>(null);
  const [weekly, setWeekly] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    Promise.all([
      api.reportsToday().then(setToday),
      api.reportsPreviousDay().then(setPreviousDay),
      api.reportsWeekly().then(setWeekly),
      api.reportsMonthly().then(setMonthly),
    ]).catch((e) =>
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)),
    );
  }, [router]);

  return (
    <PageShell title="Reports" subtitle="Order and revenue totals for your shop." wide>
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard title="Today" data={today} />
        <SummaryCard title="Previous day" data={previousDay} />
        <SummaryCard title="Last 7 days" data={weekly} />
        <SummaryCard title="This month" data={monthly} />
      </div>
    </PageShell>
  );
}
