/* ------------------------------------------------------------------ */
/* History page                                                       */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Eye, Mail, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api, type RunSummary } from '../lib/api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, SectionHeader, useToast } from '../components/ui';

type PendingDelete =
  | { kind: 'run'; id: string; label: string }
  | { kind: 'mail'; id: string; label: string }
  | { kind: 'all-runs'; count: number }
  | { kind: 'all-mail'; count: number }
  | null;

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

interface HistoryPageProps {
  onOpenRun: (id: string) => void;
  onBack: () => void;
  onOpenMailFinder?: () => void;
}

export function HistoryPage({ onOpenRun, onBack, onOpenMailFinder }: HistoryPageProps) {
  const { add: addToast } = useToast();
  const [tab, setTab] = useState<'leads' | 'mail'>('leads');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [mailJobs, setMailJobs] = useState<any[]>([]);
  const [mailLoading, setMailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [deleting, setDeleting] = useState(false);

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

  const handleRetry = useCallback(async (id: string) => {
    try {
      await api.retryRun(id);
      setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, status: 'queued' } : r)));
      addToast({ type: 'success', title: 'Retry started', message: 'Failed jobs were queued again.' });
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Retry failed',
        message: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  }, [addToast]);

  const requestDeleteRun = useCallback((r: RunSummary) => {
    setPendingDelete({
      kind: 'run',
      id: r.id,
      label: `${r.niche} · ${r.city ? `${r.city}, ` : ''}${r.state}`,
    });
  }, []);

  const requestDeleteMail = useCallback((j: any) => {
    setPendingDelete({
      kind: 'mail',
      id: j.id,
      label: `${j.niche} · ${j.city ? `${j.city}, ` : ''}${j.state}`,
    });
  }, []);

  const performDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      if (pendingDelete.kind === 'run') {
        await api.deleteRun(pendingDelete.id);
        setRuns((prev) => prev.filter((r) => r.id !== pendingDelete.id));
        addToast({
          type: 'success',
          title: 'Search deleted',
          message: `${pendingDelete.label} and its results were removed.`,
        });
      } else if (pendingDelete.kind === 'mail') {
        await api.deleteMailJob(pendingDelete.id);
        setMailJobs((prev) => prev.filter((j) => j.id !== pendingDelete.id));
        addToast({
          type: 'success',
          title: 'Mail search deleted',
          message: `${pendingDelete.label} and its emails were removed.`,
        });
      } else if (pendingDelete.kind === 'all-runs') {
        const res = await api.deleteAllRuns();
        setRuns([]);
        addToast({
          type: 'success',
          title: 'All searches deleted',
          message: `${res.deleted} searches and their results were removed.`,
        });
      } else {
        const res = await api.deleteAllMailJobs();
        setMailJobs([]);
        addToast({
          type: 'success',
          title: 'All mail searches deleted',
          message: `${res.deleted} mail searches and their emails were removed.`,
        });
      }
      setPendingDelete(null);
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Delete failed',
        message: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, addToast]);

  const handleLeadDownload = useCallback((r: RunSummary) => {
    addToast({
      type: 'info',
      title: 'Preparing Excel',
      message: `${r.niche} — ${(r.result_count || 0).toLocaleString()} contacts.`,
    });
    api.downloadResults(r.id, 'xlsx');
  }, [addToast]);

  const handleMailDownload = useCallback((j: any, format: 'xlsx' | 'csv') => {
    addToast({
      type: 'info',
      title: `Preparing ${format === 'xlsx' ? 'Excel' : 'CSV'}`,
      message: `${j.niche} — ${(j.emails_found || 0).toLocaleString()} emails.`,
    });
    api.downloadMailResults(j.id, format, {
      columns: ['business_name', 'email', 'city', 'state'],
      showInvalid: false,
    });
  }, [addToast]);

  const [histQuery, setHistQuery] = useState('');
  const [histStatus, setHistStatus] = useState('');
  const [histState, setHistState] = useState('');
  const [histFrom, setHistFrom] = useState('');
  const [histTo, setHistTo] = useState('');

  const histStates = useMemo(
    () => Array.from(new Set(runs.map((r) => r.state).filter(Boolean))).sort(),
    [runs]
  );

  const filteredRuns = useMemo(() => {
    let list = runs;
    const q = histQuery.trim().toLowerCase();
    if (q) list = list.filter((r) => (r.niche || '').toLowerCase().includes(q));
    if (histStatus) list = list.filter((r) => r.status === histStatus);
    if (histState) list = list.filter((r) => r.state === histState);
    if (histFrom) list = list.filter((r) => (r.created_at || '').slice(0, 10) >= histFrom);
    if (histTo) list = list.filter((r) => (r.created_at || '').slice(0, 10) <= histTo);
    return list;
  }, [runs, histQuery, histStatus, histState, histFrom, histTo]);

  const handleRerun = useCallback(async (r: RunSummary) => {
    try {
      const res = await api.search({
        niche: r.niche,
        state: r.state,
        city: r.city || null,
        maxResults: r.max_results ?? null,
        deepSearch: r.deep_search ? true : false,
      });
      addToast({ type: 'success', title: 'Re-run started', message: `${r.niche} is queued again.` });
      onOpenRun(res.runId);
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Re-run failed',
        message: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  }, [onOpenRun, addToast]);

  const handleDuplicate = useCallback(async (r: RunSummary) => {
    try {
      const res = await api.search({
        niche: r.niche,
        state: r.state,
        city: r.city || null,
        maxResults: r.max_results ?? null,
        deepSearch: r.deep_search ? true : false,
      });
      addToast({ type: 'success', title: 'Duplicate started', message: `${r.niche} is queued as a new search.` });
      onOpenRun(res.runId);
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Duplicate failed',
        message: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  }, [onOpenRun, addToast]);

  const reload = () => {
    setLoading(true);
    api
      .listRuns()
      .then(setRuns)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const reloadMailJobs = (silent = false) => {
    if (!silent) setMailLoading(true);
    api
      .getMailJobs()
      .then((jobs: any[]) => setMailJobs(jobs || []))
      .catch(() => {})
      .finally(() => {
        if (!silent) setMailLoading(false);
      });
  };

  useEffect(() => {
    if (tab !== 'mail') return;
    reloadMailJobs();
    const timer = window.setInterval(() => reloadMailJobs(true), 8000);
    return () => window.clearInterval(timer);
  }, [tab]);

  if (loading)
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-brand-600" />
      </div>
    );

  let confirmTitle = '';
  let confirmMessage = '';
  let confirmLabel = 'Delete';
  if (pendingDelete) {
    if (pendingDelete.kind === 'all-runs' || pendingDelete.kind === 'all-mail') {
      const isRuns = pendingDelete.kind === 'all-runs';
      confirmTitle = isRuns ? 'Delete all search history?' : 'Delete all Mail Finder history?';
      confirmMessage = `All ${pendingDelete.count} ${isRuns ? 'lead searches' : 'mail searches'} and their results will be permanently removed. This cannot be undone.`;
      confirmLabel = 'Delete all';
    } else {
      const isRun = pendingDelete.kind === 'run';
      confirmTitle = isRun ? 'Delete this search?' : 'Delete this Mail Finder search?';
      confirmMessage = `"${pendingDelete.label}" and all of its ${isRun ? 'results' : 'emails'} will be permanently removed. This cannot be undone.`;
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div>
          <SectionHeader
            title={tab === 'mail' ? 'Mail history' : 'Search history'}
            subtitle={
              tab === 'mail'
                ? 'Every Mail Finder search. Download the emails you found or delete old ones.'
                : 'Every search you have run. Open one to see its contacts, or download it.'
            }
          />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={tab === 'leads' ? reload : () => reloadMailJobs()} variant="outline" size="sm">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
          <Button
            onClick={() =>
              setPendingDelete(
                tab === 'leads'
                  ? { kind: 'all-runs', count: runs.length }
                  : { kind: 'all-mail', count: mailJobs.length }
              )
            }
            variant="danger"
            size="sm"
            disabled={deleting || (tab === 'leads' ? runs.length === 0 : mailJobs.length === 0)}
            title={tab === 'leads' ? 'Delete all lead searches' : 'Delete all mail searches'}
          >
            <Trash2 className="w-4 h-4" /> Delete all
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-slate-200 dark:border-slate-700">
        <button
          type="button"
          onClick={() => setTab('leads')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
            tab === 'leads'
              ? 'border-brand-600 text-brand-700 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          Lead Search History
        </button>
        <button
          type="button"
          onClick={() => setTab('mail')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
            tab === 'mail'
              ? 'border-brand-600 text-brand-700 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          Mail History
        </button>
      </div>

      {/* Lead Filters */}
      {tab === 'leads' && runs.length > 0 && (
        <Card padding="md">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="relative col-span-1 sm:col-span-2 lg:col-span-3">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={histQuery}
                onChange={(e) => setHistQuery(e.target.value)}
                placeholder="Search niche…"
                className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2.5 text-sm outline-none transition-colors
                  focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                  dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
              />
            </div>
            <select
              value={histStatus}
              onChange={(e) => setHistStatus(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
                focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
                dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">All statuses</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
              <option value="queued">Queued</option>
              <option value="stopped">Stopped</option>
            </select>
            <select
              value={histState}
              onChange={(e) => setHistState(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
                focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
                dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">All states</option>
              {histStates.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <div className="flex flex-col sm:flex-row sm:items-end gap-2 lg:col-span-2">
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={histFrom}
                  onChange={(e) => setHistFrom(e.target.value)}
                  className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
                    focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
                    dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
                <span className="text-slate-400 text-xs dark:text-slate-500">to</span>
              </div>
              <input
                type="date"
                value={histTo}
                onChange={(e) => setHistTo(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
                  focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
                  dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
            <div className="flex items-end lg:col-span-1">
              <Button
                onClick={() => {
                  setHistQuery('');
                  setHistStatus('');
                  setHistState('');
                  setHistFrom('');
                  setHistTo('');
                }}
                variant="outline"
                size="sm"
              >
                Clear
              </Button>
            </div>
          </div>
        </Card>
      )}

      {tab === 'leads' && (
        <>
          {filteredRuns.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">{filteredRuns.length} searches</p>
          )}

          {runs.length === 0 ? (
        <Card padding="lg">
          <EmptyState
            icon={Search}
            title="No searches yet"
            subtitle="Run a search from the Find leads page and it will appear here."
            action={
              <Button variant="primary" onClick={onBack}>
                <Search className="w-4 h-4" /> Go to Find leads
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[950px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Search</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Where</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Progress</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Contacts</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Started</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredRuns.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-slate-400 dark:text-slate-500">
                      No searches match these filters.
                    </td>
                  </tr>
                ) : (
                  filteredRuns.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => onOpenRun(r.id)}
                          className="font-medium text-slate-800 dark:text-slate-200 hover:text-brand-600 dark:hover:text-brand-400 hover:underline text-left"
                          title="Open this search"
                        >
                          {r.niche}
                        </button>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                          {r.state}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                        {r.city ? `${r.city}, ${r.state}` : r.state}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            r.status === 'done'
                              ? 'done'
                              : r.status === 'failed'
                                ? 'failed'
                                : r.status === 'stopped'
                                  ? 'stopped'
                                  : r.status === 'running'
                                    ? 'running'
                                    : 'queued'
                          }
                          size="sm"
                        />
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {r.completed_cities} / {r.total_cities}
                        {r.failed_cities > 0 && (
                          <span className="text-red-600 dark:text-red-400 ml-1">({r.failed_cities} failed)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">
                        {r.result_count.toLocaleString()}
                        {r.provider_counts && r.provider_counts.length > 0 && (
                          <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                            {r.provider_counts.map((pc) => `${pc.provider}+${pc.new_contacts}`).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {formatDate(r.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                          {/* Primary: View */}
                          <Button
                            onClick={() => onOpenRun(r.id)}
                            variant="primary"
                            size="sm"
                          >
                            <Eye className="w-3.5 h-3.5" /> View
                          </Button>
                          <Button
                            onClick={() => handleLeadDownload(r)}
                            variant="outline"
                            size="sm"
                          >
                            <Download className="w-3.5 h-3.5" /> Excel
                          </Button>
                          {r.status === 'failed' && (
                            <Button
                              onClick={() => handleRetry(r.id)}
                              variant="danger"
                              size="sm"
                            >
                              <RefreshCw className="w-3.5 h-3.5" /> Retry
                            </Button>
                          )}
                          <Button
                            onClick={() => handleRerun(r)}
                            variant="outline"
                            size="sm"
                          >
                            <RefreshCw className="w-3.5 h-3.5" /> Re-run
                          </Button>
                          <Button
                            onClick={() => handleDuplicate(r)}
                            variant="outline"
                            size="sm"
                          >
                            <Search className="w-3.5 h-3.5" /> Duplicate
                          </Button>
                          <Button
                            onClick={() => requestDeleteRun(r)}
                            variant="danger"
                            size="sm"
                            title="Delete this search"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
        </>
      )}

      {tab === 'mail' && (
        <div className="mt-6">
          {mailLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin text-brand-600" />
            </div>
          ) : mailJobs.length === 0 ? (
            <Card padding="lg">
              <EmptyState
                icon={Mail}
                title="No Mail Finder searches yet"
                subtitle="Run a Mail Finder search and it will appear here."
                action={
                  <Button variant="primary" onClick={() => (onOpenMailFinder ? onOpenMailFinder() : onBack())}>
                    <Search className="w-4 h-4" /> Go to Mail Finder
                  </Button>
                }
              />
            </Card>
          ) : (
            <Card padding="none">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[950px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Search</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Where</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Emails Found</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Started</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {mailJobs.map((j: any) => (
                      <tr key={j.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                        <td className="px-4 py-3">
                          <span className="font-medium text-slate-800 dark:text-slate-200">{j.niche}</span>
                          <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{j.state}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                          {j.city ? `${j.city}, ${j.state}` : j.state}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              j.status === 'done'
                                ? 'done'
                                : j.status === 'failed'
                                  ? 'failed'
                                  : j.status === 'stopped'
                                    ? 'stopped'
                                    : j.status === 'running'
                                      ? 'running'
                                      : 'queued'
                            }
                            size="sm"
                          >
                            {j.status === 'done'
                              ? 'Done'
                              : j.status === 'failed'
                                ? 'Failed'
                                : j.status === 'stopped'
                                  ? 'Stopped'
                                  : j.status === 'running'
                                    ? 'Running'
                                    : 'Queued'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">
                          {j.emails_found || 0}
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {formatDate(j.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                            <Button
                              onClick={() => handleMailDownload(j, 'xlsx')}
                              variant="primary"
                              size="sm"
                            >
                              <Download className="w-3.5 h-3.5" /> Excel
                            </Button>
                            <Button
                              onClick={() => handleMailDownload(j, 'csv')}
                              variant="outline"
                              size="sm"
                            >
                              <Download className="w-3.5 h-3.5" /> CSV
                            </Button>
                            <Button
                              onClick={() => requestDeleteMail(j)}
                              variant="danger"
                              size="sm"
                              title="Delete this search"
                            >
                              <Trash2 className="w-3.5 h-3.5" /> Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400 mt-6 text-center max-w-3xl mx-auto">
        Use these emails only for relevant business outreach. Include a clear unsubscribe option and follow India's
        anti-spam and data protection rules.
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        cancelLabel="Cancel"
        danger
        loading={deleting}
        onConfirm={performDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />
    </div>
  );
}
