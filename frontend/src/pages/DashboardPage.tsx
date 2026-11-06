/* ------------------------------------------------------------------ */
/* Dashboard page                                                     */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useState, type ElementType, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  StopCircle,
  TrendingUp,
  Users,
} from 'lucide-react';
import { api, type Lead, type Progress, type RunSummary } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  SectionHeader,
  Table,
  TableBodyCell,
  TableHeadCell,
} from '../components/ui';

const PAGE_SIZE = 25;
const TERMINAL_STATUSES = ['done', 'failed', 'stopped'];

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function elapsedLabel(startIso: string | null | undefined, now: number): string {
  if (!startIso) return '00:00';
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '00:00';
  const diff = Math.max(0, now - start);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function pageNumbers(current: number, totalPages: number): number[] {
  const max = 7;
  if (totalPages <= max) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const half = Math.floor(max / 2);
  let start = Math.max(1, current - half);
  const end = Math.min(totalPages, start + max - 1);
  start = Math.max(1, end - max + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

interface DashboardPageProps {
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
}

export function DashboardPage({ activeRunId, setActiveRunId }: DashboardPageProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [totalContactsFromApi, setTotalContactsFromApi] = useState<number | null>(null);

  /* ---------- load runs ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.listRuns();
        if (!cancelled) setRuns(data);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- load total contacts from leads API ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getLeads('?page=1&limit=1');
        if (!cancelled) setTotalContactsFromApi(data.total);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- poll active run progress ---------- */
  useEffect(() => {
    if (!activeRunId) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    let intervalId = 0;

    const tick = async () => {
      try {
        const p = await api.getProgress(activeRunId);
        if (cancelled) return;
        setProgress(p);
      } catch {
        /* ignore */
      }
    };

    intervalId = window.setInterval(tick, 2000);
    tick();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRunId, pollKey]);

  /* ---------- live timer ---------- */
  useEffect(() => {
    if (!activeRunId || !progress) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeRunId, progress]);

  /* ---------- aggregates ---------- */
  const totalContacts = useMemo(
    () => runs.reduce((sum, r) => sum + (r.result_count || 0), 0),
    [runs]
  );
  const totalSearches = runs.length;
  const doneSearches = runs.filter((r) => r.status === 'done').length;
  const successRate = totalSearches > 0 ? Math.round((doneSearches / totalSearches) * 100) : 0;
  const thisWeek = runs.filter((r) => {
    const d = new Date(r.created_at || 0);
    const now = new Date();
    return now.getTime() - d.getTime() <= 7 * 24 * 60 * 60 * 1000;
  }).length;

  const byState = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of runs) m[r.state] = (m[r.state] || 0) + (r.result_count || 0);
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [runs]);

  const recentRuns = useMemo(
    () => [...runs].sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()).slice(0, 6),
    [runs]
  );

  const status = activeRunId ? progress?.status ?? 'queued' : 'idle';
  const isRunning = !!activeRunId && !TERMINAL_STATUSES.includes(status);
  const byStatusSum = progress
    ? Object.values(progress.byStatus || {}).reduce((acc, c) => acc + (Number(c) || 0), 0)
    : 0;
  const totalTasks = byStatusSum > 0 ? byStatusSum : progress?.totalCities ?? 0;
  const okTasks = progress?.byStatus?.ok ?? progress?.completedCities ?? 0;
  const failedTasks = progress?.byStatus?.failed ?? progress?.failedCities ?? 0;
  const doneTasks = okTasks + failedTasks;
  const pct = totalTasks > 0 ? Math.min(100, Math.round((doneTasks / totalTasks) * 100)) : 0;
  const elapsed = elapsedLabel(progress?.startedAt, now);

  const openRun = (id: string) => {
    setActiveRunId(id);
  };

  /* ---------- stat card ---------- */
  const statCard = (title: string, value: ReactNode, trend?: string, icon: ElementType = Users, color = 'brand') => {
    const Icon = icon;
    const colorMap: Record<string, string> = {
      brand: 'bg-brand-50 text-brand-700 dark:bg-brand-900/20 dark:text-brand-400',
      green: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
      blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
      amber: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
    };
    return (
      <Card padding="sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">{title}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{value}</p>
            {trend && (
              <p className={`text-xs font-medium mt-1 ${color === 'brand' ? 'text-brand-600' : 'text-slate-600'} dark:text-slate-400`}>
                {trend}
              </p>
            )}
          </div>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center {colorMap[color]}">
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <SectionHeader title="Dashboard" subtitle="Overview of your lead searches and collected contacts." />

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {statCard('Total contacts', (totalContactsFromApi ?? totalContacts).toLocaleString(), `${thisWeek} this week`, Users, 'brand')}
        {statCard('Searches this week', thisWeek.toLocaleString(), `${totalSearches} total`, Search, 'green')}
        {statCard('Success rate', `${successRate}%`, `${doneSearches} of ${totalSearches} done`, CheckCircle2, 'blue')}
        {statCard('Last search', recentRuns.length > 0 ? formatDate(recentRuns[0].created_at) : '—', recentRuns.length > 0 ? recentRuns[0].niche : 'none', Clock, 'amber')}
      </div>

      {/* Live search card */}
      {activeRunId && progress && (
        <Card padding="md">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                Live search <span className="text-brand-700 dark:text-brand-400">{progress.niche}</span> in{' '}
                {progress.city ? `${progress.city}, ${progress.state}` : progress.state}
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Status: <Badge variant={status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'running'} size="sm" />
              </p>
            </div>
            <Badge variant="running" size="md">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {isRunning ? 'Searching' : 'Idle'}
            </Badge>
          </div>

          <div className="rounded-2xl p-5 mb-5 bg-brand-50 dark:bg-brand-900/20 border border-brand-100 dark:border-brand-900/40">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-5">
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 dark:text-slate-400">Contacts found</p>
                <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">
                  {(progress.resultCount ?? 0).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 dark:text-slate-400">Searches completed</p>
                <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">
                  {doneTasks}
                  <span className="text-lg text-slate-400 dark:text-slate-500 font-semibold"> / {totalTasks}</span>
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5 dark:text-slate-400">
                  <Clock className="w-3.5 h-3.5" /> Time elapsed
                </p>
                <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">{elapsed}</p>
              </div>
            </div>

            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5 overflow-hidden mb-3">
              <div className="h-2.5 rounded-full bg-brand-600 transition-all duration-700" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 mb-4">
              <span className="truncate max-w-[70%]">
                {totalTasks === 0 ? 'Preparing search queries…' : progress.currentArea || `Now: ${progress.niche}`}
              </span>
              <span>{pct}%</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {progress.byStatus?.ok > 0 && <Badge variant="done" size="sm">{progress.byStatus.ok} done</Badge>}
              {progress.byStatus?.failed > 0 && <Badge variant="failed" size="sm">{progress.byStatus.failed} failed</Badge>}
              {progress.byStatus?.working > 0 && <Badge variant="running" size="sm">{progress.byStatus.working} running</Badge>}
              {progress.byStatus?.queued > 0 && <Badge variant="queued" size="sm">{progress.byStatus.queued} queued</Badge>}
              <span className="text-slate-600 dark:text-slate-400 text-xs">Provider: <b className="text-slate-800 dark:text-slate-200">{progress.currentProvider || 'gosom'}</b></span>
            </div>
          </div>
        </Card>
      )}

      {/* Contacts by state chart */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Contacts by state</h3>
          <Button variant="outline" size="sm" onClick={() => setPollKey((k) => k + 1)}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
        {byState.length === 0 ? (
          <EmptyState icon={Users} title="No data yet" subtitle="Run a search to see contacts by state." />
        ) : (
          <div className="space-y-3">
            {byState.map(([state, count]) => {
              const max = byState[0][1];
              const pct = max > 0 ? Math.round((count / max) * 100) : 0;
              return (
                <div key={state} className="flex items-center gap-3">
                  <span className="w-20 text-xs text-slate-600 dark:text-slate-400">{state}</span>
                  <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                    <div className="h-3 rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-16 text-xs text-right text-slate-800 dark:text-slate-200 font-medium">{count.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Recent searches */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Recent searches</h3>
          <Button variant="outline" size="sm" onClick={() => setPollKey((k) => k + 1)}>
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
        {recentRuns.length === 0 ? (
          <EmptyState icon={Search} title="No recent searches" subtitle="Start a search from Find leads." />
        ) : (
          <Table minW="700px">
            <thead>
              <tr>
                <TableHeadCell>Search</TableHeadCell>
                <TableHeadCell>Where</TableHeadCell>
                <TableHeadCell>Status</TableHeadCell>
                <TableHeadCell>Contacts</TableHeadCell>
                <TableHeadCell>Started</TableHeadCell>
                <TableHeadCell className="text-right">Action</TableHeadCell>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentRuns.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                  <TableBodyCell className="font-medium text-slate-800 dark:text-slate-200">{r.niche}</TableBodyCell>
                  <TableBodyCell className="text-slate-600 dark:text-slate-400">{r.city ? `${r.city}, ${r.state}` : r.state}</TableBodyCell>
                  <TableBodyCell>
                    <Badge
                      variant={
                        r.status === 'done' ? 'done' : r.status === 'failed' ? 'failed' : r.status === 'stopped' ? 'stopped' : r.status === 'running' ? 'running' : 'queued'
                      }
                      size="sm"
                    />
                  </TableBodyCell>
                  <TableBodyCell className="font-medium text-slate-800 dark:text-slate-200">{r.result_count.toLocaleString()}</TableBodyCell>
                  <TableBodyCell className="text-slate-600 dark:text-slate-400 whitespace-nowrap">{formatDate(r.created_at)}</TableBodyCell>
                  <TableBodyCell className="text-right">
                    <Button onClick={() => openRun(r.id)} variant="outline" size="sm">
                      <Eye className="w-3.5 h-3.5" /> View
                    </Button>
                  </TableBodyCell>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
