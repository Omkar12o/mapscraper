/* ------------------------------------------------------------------ */
/* Mail Finder page – emails only: Business Name, Email, City, State    */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Mail,
  RefreshCw,
  Search,
  StopCircle,
} from 'lucide-react';
import { api, type StateOption } from '../lib/api';
import { Badge, Button, Card, CopyButton, EmptyState, Input, Select } from '../components/ui';

const PAGE_SIZE = 50;
const QUICK_PICKS = ['NGO', 'School', 'Hospital', 'IT company', 'CA', 'CEO', 'Pvt Ltd'];
const LEAD_TARGET_OPTIONS = ['500', '1000', '2000', '3000', '5000', '10000', 'All available'];
const TERMINAL_MAIL_STATUSES = ['done', 'failed', 'stopped'];

const DEFAULT_EXPORT_COLUMNS = ['business_name', 'email', 'city', 'state'];

type FilterKey = 'all' | 'valid' | 'risky' | 'generic' | 'personal';

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

function statusLabel(status: string): string {
  if (status === 'done') return 'Done';
  if (status === 'failed') return 'Failed';
  if (status === 'stopped') return 'Stopped';
  if (status === 'queued') return 'Queued';
  return 'Searching…';
}

interface MailResult {
  business_name: string;
  email: string;
  city: string;
  state: string;
  status: string;
}

interface MailSource {
  id: string;
  niche: string;
  state: string;
  city: string | null;
  result_count: number;
  with_email: number;
  created_at: string;
}

export function MailFinderPage() {
  const [states, setStates] = useState<StateOption[]>([]);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [citiesForState, setCitiesForState] = useState<string[]>([]);
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [resultCity, setResultCity] = useState<string | null>(null);
  const [niche, setNiche] = useState<string>('');
  const [maxLeads, setMaxLeads] = useState<string>('5000');
  const [deepSearch, setDeepSearch] = useState<boolean>(true);

  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<any>(null);
  const [results, setResults] = useState<MailResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [showInvalid, setShowInvalid] = useState(false);
  const [newEmailsOnly, setNewEmailsOnly] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [showExport, setShowExport] = useState(false);

  const status = jobId ? progress?.status ?? 'queued' : 'idle';
  const isRunning = !!jobId && !TERMINAL_MAIL_STATUSES.includes(status);
  const isFinished = !!jobId && TERMINAL_MAIL_STATUSES.includes(status);
  const isFailed = status === 'failed';
  const isStopped = status === 'stopped';

  /* ---------- load states ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const s = await api.getStates();
          if (cancelled) return;
          setStates(s);
          setSelectedState((current) => (current && s.some((x) => x.name === current) ? current : s[0]?.name || current));
          setError(null);
          return;
        } catch {
          if (cancelled) return;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!cancelled) setError('Failed to load states. Is the backend running?');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- load cities ---------- */
  useEffect(() => {
    if (!selectedState) {
      setCitiesForState([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getCities(selectedState);
        if (!cancelled) setCitiesForState(data.cities || []);
      } catch {
        if (!cancelled) setCitiesForState([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedState]);

  /* ---------- poll progress ---------- */
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let intervalId = 0;

    const tick = async () => {
      try {
        const p = await api.getMailProgress(jobId);
        if (cancelled) return;
        setProgress(p);
        if (TERMINAL_MAIL_STATUSES.includes(p.status)) window.clearInterval(intervalId);
      } catch {
        /* keep polling */
      }
    };

    intervalId = window.setInterval(tick, 2000);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [jobId]);

  /* ---------- load results ---------- */
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getMailResults(jobId, {
          page,
          limit: PAGE_SIZE,
          q: query.trim(),
          filter: filter === 'all' ? '' : filter,
          newOnly: newEmailsOnly,
          showInvalid,
          city: resultCity || selectedCity || null,
        });
        if (cancelled) return;
        setResults(data.rows || []);
        setTotal(data.total || 0);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, page, query, filter, newEmailsOnly, showInvalid, progress?.resultsFound, resultCity]);

  /* ---------- live timer ---------- */
  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const resetJob = () => {
    setJobId(null);
    setProgress(null);
    setResults([]);
    setTotal(0);
    setPage(1);
    setQuery('');
    setFilter('all');
    setError(null);
  };

  const handleSearch = async () => {
    const cleanNiche = niche.trim().replace(/\s+/g, ' ');
    if (submitting || isRunning) return;
    if (!cleanNiche || !selectedState) return;

    const target = maxLeads === 'All available' ? null : Number.parseInt(maxLeads, 10) || null;

    resetJob();
    setSubmitting(true);
    try {
      const res = await api.searchMail({
        mode: 'new',
        niche: cleanNiche,
        state: selectedState,
        city: selectedCity || null,
        maxResults: target,
        deepSearch,
        extraVariants: [],
      });
      setJobId(res.mailJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (!jobId) return;
    try {
      await api.stopMailJob(jobId);
      setProgress((p: any) => (p ? { ...p, status: 'stopped' } : p));
    } catch {
      setError('Could not stop the search.');
    }
  };

  const locationLabel = selectedCity ? `${selectedCity}, ${selectedState}` : selectedState || '';
  const elapsed = elapsedLabel(progress?.startedAt || progress?.createdAt, now);
  const emailsFound = Number(progress?.resultsFound ?? total ?? 0);
  const checked = Number(progress?.businessesChecked ?? progress?.websitesChecked ?? 0);
  const totalBusinesses = Number(progress?.businessesTotal ?? 0);
  const withEmail = Number(progress?.businessesWithEmail ?? progress?.websitesWithEmail ?? 0);

  const filterChips: { key: FilterKey; label: string }[] = [
    { key: 'all', label: 'All emails' },
    { key: 'valid', label: 'Valid only' },
    { key: 'risky', label: 'Risky' },
    { key: 'generic', label: 'Generic' },
    { key: 'personal', label: 'Personal' },
  ];

  const exportCols = useMemo(() => DEFAULT_EXPORT_COLUMNS, []);

  // Exports download every matching row (not just this page) while respecting
  // the city filter, the search box, the type filter and "new emails only".
  const exportOptions = {
    columns: exportCols,
    showInvalid,
    city: resultCity || selectedCity || null,
    q: query.trim() || undefined,
    filter: filter === 'all' ? undefined : filter,
    newOnly: newEmailsOnly,
  };

  /* ---------- processing card ---------- */
  const processingCard = jobId && progress ? (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white break-words">
            {progress.niche || niche} in {progress.city ? `${progress.city}, ${progress.state}` : progress.state || locationLabel}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {progress.stage === 'collecting businesses'
              ? emailsFound > 0
                ? 'Collecting more businesses and reading websites…'
                : 'Collecting business listings…'
              : 'Reading websites for public emails…'}
          </p>
        </div>
        <Badge variant={isFailed ? 'failed' : isStopped ? 'stopped' : status === 'done' ? 'done' : 'running'} size="md">
          {statusLabel(status)}
        </Badge>
      </div>

      <div className="rounded-2xl p-5 mb-5 bg-brand-50 dark:bg-brand-900/20 border border-brand-100 dark:border-slate-900/40">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-5">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 dark:text-slate-400">Emails found</p>
            <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">{emailsFound.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 dark:text-slate-400">Businesses checked</p>
            <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">
              {checked.toLocaleString()}
              {totalBusinesses > 0 && (
                <span className="text-lg text-slate-500 dark:text-slate-400 font-semibold"> of {totalBusinesses.toLocaleString()}</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1.5 dark:text-slate-400">
              <Clock className="w-3.5 h-3.5" /> Time elapsed
            </p>
            <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">{elapsed}</p>
          </div>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-300">
          Checked <b>{checked.toLocaleString()}</b> businesses, <b>{withEmail.toLocaleString()}</b> had a public email.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 mt-3">
          <span className="truncate max-w-[70%]">
            {progress.currentWebsite ? `Now: ${progress.currentWebsite}` : progress.stage === 'queued' ? 'Queued…' : 'Preparing…'}
          </span>
          <span>Target: <b className="text-slate-800 dark:text-slate-200">{maxLeads === 'All available' ? 'All available' : `${maxLeads} leads`}</b> · Provider: <b className="text-slate-800 dark:text-slate-200">gosom + website crawl</b></span>
        </div>
      </div>

      {isFailed && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-red-800 text-sm flex flex-wrap items-center gap-3 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1 min-w-[200px]">
            {progress.errorReason || 'The search could not be completed.'}
          </span>
          <Button variant="danger" size="sm" onClick={handleSearch} disabled={submitting}>
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </Button>
        </div>
      )}
      {isStopped && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-amber-800 text-sm flex items-start gap-3 dark:bg-red-900/20 dark:border-red-800 dark:text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">Search stopped. Emails found so far are saved and can be downloaded.</span>
        </div>
      )}
    </Card>
  ) : null;

  /* ---------- results card ---------- */
  const resultsCard = jobId && total > 0 ? (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white break-words">
            {emailsFound.toLocaleString()} emails for "{niche}" in {selectedCity ? `${selectedCity}, ${selectedState}` : selectedState || ''}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Checked {checked.toLocaleString()} businesses, {withEmail.toLocaleString()} had a public email.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowExport((s) => !s)}>
            <Download className="w-4 h-4" /> Columns
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => api.downloadMailResults(jobId, 'xlsx', exportOptions)}
          >
            <Download className="w-4 h-4" /> Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => api.downloadMailResults(jobId, 'csv', exportOptions)}
          >
            <Download className="w-4 h-4" /> CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <Input
          className="flex-1 sm:max-w-[280px]"
          placeholder="Search email or business name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="sm:max-w-[180px]"
          value={resultCity || ''}
          onChange={(e) => setResultCity(e.target.value || null)}
          disabled={isRunning || submitting || citiesForState.length === 0}
        >
          <option value="">City</option>
          {citiesForState.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400 w-12">#</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Business name</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Email</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">City</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {results.map((r, i) => (
              <tr key={`${r.email}-${i}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                <td className="px-4 py-3 text-slate-500 dark:text-slate-400 tabular-nums">{(page - 1) * PAGE_SIZE + i + 1}</td>
                <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200 break-words max-w-[260px]">
                  {r.business_name || '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <a
                      href={`mailto:${r.email}`}
                      className="text-brand-600 hover:underline font-medium dark:text-brand-400 truncate max-w-[280px]"
                      title={r.email}
                    >
                      {r.email}
                    </a>
                    <CopyButton value={r.email} />
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{r.city || ''}</td>
                <td className="px-4 py-3 whitespace-nowrap">{r.state || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-1 py-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400 mt-2">
        <div>
          Showing <b className="text-slate-800 dark:text-slate-200">{(page - 1) * PAGE_SIZE + 1}</b>–
          <b className="text-slate-800 dark:text-slate-200">{Math.min(page * PAGE_SIZE, total)}</b> of{' '}
          <b className="text-slate-800 dark:text-slate-200">{total.toLocaleString()}</b> emails
        </div>
        {Math.ceil(total / PAGE_SIZE) > 1 && (
          <div className="flex items-center gap-1">
            <Button disabled={page === 1} onClick={() => setPage(page - 1)} variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {pageNumbers(page, Math.ceil(total / PAGE_SIZE)).map((p) => (
              <Button key={p} onClick={() => setPage(p)} variant={p === page ? 'primary' : 'outline'} size="sm">
                {p}
              </Button>
            ))}
            <Button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage(page + 1)} variant="outline" size="sm">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    </Card>
  ) : null;

  /* ---------- empty card ---------- */
  const emptyCard = jobId && results.length === 0 && isFinished ? (
    <Card padding="lg">
      <EmptyState
        icon={Mail}
        title="No emails found"
        subtitle={
          progress?.errorReason || `No public emails were found. Checked ${checked.toLocaleString()} businesses. Not every business publishes an email, so you will usually find fewer emails than phone numbers.`
        }
      />
      <div className="mt-4 flex justify-center">
        <Button variant="outline" size="sm" onClick={() => api.downloadMailResults(jobId, 'xlsx', exportOptions)}>
          <Download className="w-4 h-4" /> Download (0 rows)
        </Button>
      </div>
    </Card>
  ) : null;

  return (
    <div className="px-6 max-w-[1100px] w-full pt-6">
      {/* Page title and subtitle */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Mail Finder</h1>
        <p className="text-slate-500 dark:text-slate-400">
          Search a niche, state and city. You get business name and email only.
        </p>
      </div>

      <div className="mt-6">
        <Card padding="md">
          <div className="space-y-4">
            {/* Search card */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2" htmlFor="mail-niche">
                  What are you looking for
                </label>
                <Input
                  id="mail-niche"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  placeholder="e.g. CA, NGO, Hospital"
                  disabled={isRunning || submitting}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2" htmlFor="mail-state">
                  State
                </label>
                <Select
                  id="mail-state"
                  value={selectedState || ''}
                  onChange={(e) => {
                    setSelectedState(e.target.value);
                    setSelectedCity(null);
                  }}
                  disabled={isRunning || submitting}
                >
                  <option value="">Select state</option>
                  {states.map((s) => (
                    <option key={s.code} value={s.name}>{s.name}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2" htmlFor="mail-city">
                  City or district
                </label>
                <Select
                  id="mail-city"
                  value={selectedCity || ''}
                  onChange={(e) => setSelectedCity(e.target.value || null)}
                  disabled={isRunning || submitting || citiesForState.length === 0}
                >
                  <option value="">All cities in {selectedState || 'state'}</option>
                  {citiesForState.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {QUICK_PICKS.map((pick) => (
                <button
                  key={pick}
                  type="button"
                  onClick={() => setNiche(pick)}
                  className={`px-3.5 py-2 rounded-xl border text-sm font-medium transition disabled:opacity-50 ${
                    niche === pick ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-300 text-slate-700 hover:border-brand-400 dark:border-slate-600 dark:text-slate-300 dark:hover:border-brand-400'
                  }`}
                  disabled={isRunning || submitting}
                >
                  {pick}
                </button>
              ))}
            </div>

            <hr className="my-4 border-slate-200 dark:border-slate-700"/>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2" htmlFor="mail-max-leads">
                  Maximum leads to collect
                </label>
                <Select
                  id="mail-max-leads"
                  value={maxLeads}
                  onChange={(e) => setMaxLeads(e.target.value)}
                  disabled={isRunning || submitting}
                >
                  {LEAD_TARGET_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </Select>
              </div>
              <label className="flex items-start gap-2.5 text-sm text-slate-600 dark:text-slate-300 cursor-pointer select-none sm:mt-7">
                <input
                  type="checkbox"
                  className="w-4 h-4 mt-0.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  checked={deepSearch}
                  onChange={(e) => setDeepSearch(e.target.checked)}
                  disabled={isRunning || submitting}
                />
                <span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">Deep search</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    More keywords and neighbourhoods — highest volume, takes longer.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-4 flex gap-2">
              <Button
                onClick={handleSearch}
                disabled={isRunning || submitting || !niche.trim() || !selectedState}
                loading={submitting}
                variant="primary"
                size="lg"
              >
                {submitting ? 'Searching…' : (
                  <span>
                    <Search className="w-5 h-5" /> Search emails
                  </span>
                )}
              </Button>
              {isRunning && (
                <Button onClick={handleStop} variant="danger" size="lg">
                  <StopCircle className="w-4 h-4" /> Stop
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-6">
        {processingCard}
        {resultsCard}
        {emptyCard}
      </div>

      {!jobId && (
        <div className="mt-6">
          <Card padding="lg">
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-4 dark:bg-brand-900/20">
                <Mail className="w-6 h-6 text-brand-600" />
              </div>
              <p className="text-slate-700 dark:text-slate-300 font-medium">Ready when you are</p>
              <p className="text-slate-500 text-sm mt-1 dark:text-slate-400 max-w-lg mx-auto">
                Choose a niche and state, then press Search. Not every business publishes an email, so you will
                usually find fewer emails than phone numbers.
              </p>
            </div>
          </Card>
        </div>
      )}

      {jobId && isFinished && !isFailed && (
        <p className="text-sm text-center text-emerald-700 dark:text-emerald-400 mt-4 flex items-center justify-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {emailsFound.toLocaleString()} emails found in {elapsed}.
        </p>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400 mt-6 text-center max-w-3xl mx-auto">
        Use these emails only for relevant business outreach. Include a clear unsubscribe option and follow India's
        anti-spam and data protection rules.
      </p>
    </div>
  );
}