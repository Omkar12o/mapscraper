/* ------------------------------------------------------------------ */
/* Find leads page                                                    */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
} from 'lucide-react';
import { api, type Lead, type Progress, type RunSummary, type StateOption } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  Skeleton,
  Table,
  TableBodyCell,
  TableHeadCell,
} from '../components/ui';

const PAGE_SIZE = 25;
const LEVEL_LABELS: Record<number, string> = {
  1: 'cities & districts',
  2: 'areas, localities & pincodes',
  3: 'keyword variants',
  4: 'geo grid',
};
const QUICK_PICKS = [
  'NGO',
  'School',
  'Hospital',
  'IT company',
  'Coaching institute',
  'CA',
  'CEO',
  'Business person',
  'Enterprise',
  'Pvt Ltd',
];
const RESULT_OPTIONS = ['All available', '500', '1000', '3000', '5000'];
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

export function FindLeadsPage({
  runId,
  onRunChange,
}: {
  runId: string | null;
  onRunChange: (runId: string | null) => void;
}) {
  const [states, setStates] = useState<StateOption[]>([]);
  const [selectedState, setSelectedState] = useState('Maharashtra');
  const [citiesForState, setCitiesForState] = useState<string[]>([]);
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [niche, setNiche] = useState('NGO');
  const [extraVariants, setExtraVariants] = useState('');
  const [maxResults, setMaxResults] = useState('All available');
  const [deepSearch, setDeepSearch] = useState(true);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [resultsVersion, setResultsVersion] = useState(0);
  const [startedAtLocal, setStartedAtLocal] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const lastCountRef = useRef(-1);

  const status = runId ? progress?.status ?? 'queued' : 'idle';
  const isRunning = !!runId && !TERMINAL_STATUSES.includes(status) && !stalled;
  const isFinished = !!runId && TERMINAL_STATUSES.includes(status);
  const isBusy = submitting || (!!runId && !isFinished);

  const locationLabel = selectedCity ? `${selectedCity}, ${selectedState}` : selectedState;

  /* ---------- load states once ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const s = await api.getStates();
          if (cancelled) return;
          setStates(s);
          setSelectedState((current) =>
            current && s.some((x) => x.name === current) ? current : s[0]?.name || current
          );
          setError(null);
          return;
        } catch {
          if (cancelled) return;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!cancelled) setError('Failed to load states. Is the backend running on port 5000?');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- load cities for the selected state ---------- */
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

  /* ---------- reset the view when a different run is opened ---------- */
  useEffect(() => {
    setProgress(null);
    setLeads([]);
    setTotal(0);
    setPage(1);
    setQuery('');
    setStalled(false);
    setStartedAtLocal(null);
    lastCountRef.current = -1;
    if (runId) setError(null);
  }, [runId]);

  /* ---------- mirror the run's location into the form ---------- */
  useEffect(() => {
    if (!progress) return;
    if (progress.state) setSelectedState(progress.state);
    if (progress.city) setSelectedCity(progress.city);
  }, [progress?.state, progress?.city]);

  /* ---------- poll run progress ---------- */
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let failures = 0;
    let intervalId = 0;

    const tick = async () => {
      try {
        const p = await api.getProgress(runId);
        if (cancelled) return;
        failures = 0;
        setProgress(p);
        if (p.resultCount !== lastCountRef.current) {
          lastCountRef.current = p.resultCount;
          setResultsVersion((v) => v + 1);
        }
        if (TERMINAL_STATUSES.includes(p.status)) {
          window.clearInterval(intervalId);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : '';
        if (message.includes('not found')) {
          window.clearInterval(intervalId);
          onRunChange(null);
          setProgress(null);
          setError('That search could not be found. Start a new search.');
          return;
        }
        failures += 1;
        if (failures >= 5) {
          window.clearInterval(intervalId);
          setStalled(true);
          setError('Lost connection to the backend. The search may still be running on the server.');
        }
      }
    };

    intervalId = window.setInterval(tick, 2000);
    tick();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [runId, pollKey]);

  /* ---------- load results (refetches as new leads arrive) ---------- */
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        try {
          const data = await api.getResults(runId, {
            page,
            limit: PAGE_SIZE,
            q: query.trim(),
            sort: isRunning ? 'recent' : 'name',
          });
          if (cancelled) return;
          setLeads(data.rows);
          setTotal(data.total);
        } catch {
          /* progress polling surfaces connection errors */
        }
      },
      query ? 300 : 0
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runId, page, query, resultsVersion, isRunning]);

  /* ---------- keep page in range ---------- */
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) setPage(totalPages);
  }, [total, page]);

  /* ---------- live elapsed timer ---------- */
  useEffect(() => {
    if (!isRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const handleSearch = async () => {
    const cleanNiche = niche.trim().replace(/\s+/g, ' ');
    if (!cleanNiche || !selectedState || isBusy) return;
    setError(null);
    setStalled(false);
    onRunChange(null);
    setProgress(null);
    setLeads([]);
    setTotal(0);
    setPage(1);
    setQuery('');
    setSubmitting(true);
    setStartedAtLocal(new Date().toISOString());
    lastCountRef.current = -1;

    try {
      const mr = maxResults === 'All available' ? null : parseInt(maxResults, 10) || null;
      const ev = extraVariants
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.search({
        niche: cleanNiche,
        state: selectedState,
        city: selectedCity || null,
        maxResults: mr,
        deepSearch,
        extraVariants: ev,
      });
      setSelectedState(res.state);
      onRunChange(res.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (!runId) return;
    try {
      await api.stopRun(runId);
      setProgress((p) => (p ? { ...p, status: 'stopped' } : p));
    } catch {
      setError('Could not stop the search. Please try again.');
    }
  };

  const retryConnection = () => {
    setError(null);
    setStalled(false);
    setPollKey((k) => k + 1);
  };

  /* ---------- derived progress numbers ---------- */
  const byStatusSum = progress
    ? Object.values(progress.byStatus || {}).reduce((acc, c) => acc + (Number(c) || 0), 0)
    : 0;
  const totalTasks = byStatusSum > 0 ? byStatusSum : progress?.totalCities ?? 0;
  const okTasks = progress?.byStatus?.ok ?? progress?.completedCities ?? 0;
  const failedTasks = progress?.byStatus?.failed ?? progress?.failedCities ?? 0;
  const workingTasks = progress?.byStatus?.working ?? 0;
  const queuedTasks =
    progress?.byStatus?.queued ?? Math.max(0, totalTasks - okTasks - failedTasks - workingTasks);
  const doneTasks = okTasks + failedTasks;
  const pct = totalTasks > 0 ? Math.min(100, Math.round((doneTasks / totalTasks) * 100)) : 0;
  const elapsed = elapsedLabel(progress?.startedAt || startedAtLocal, now);
  const duplicatesRemoved = progress?.duplicatesRemoved ?? 0;
  const runNiche = progress?.niche || niche;
  const runLocation = progress
    ? progress.city
      ? `${progress.city}, ${progress.state}`
      : progress.state
    : locationLabel;
  const currentQuery = progress?.currentArea || `${runNiche} in ${runLocation}`;

  /* ---------- search card ---------- */
  const searchCard = (
    <Card padding="md">
      <div className="mb-5">
        <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Find business contacts</h2>
        <p className="text-sm text-slate-400">
          Pick a niche and location. You get business name, phone number, address and email.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-2" htmlFor="niche">
            What are you looking for
          </label>
          <Input
            id="niche"
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            placeholder="e.g. NGO, school, hospital"
            disabled={isBusy}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-2" htmlFor="state">
            State
          </label>
          <Select
            id="state"
            value={selectedState}
            onChange={(e) => {
              setSelectedState(e.target.value);
              setSelectedCity(null);
            }}
            disabled={isBusy}
          >
            <option value="">Select state</option>
            {states.map((s) => (
              <option key={s.code} value={s.name}>{s.name}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-2" htmlFor="city">
            City or district
          </label>
          <Select
            id="city"
            value={selectedCity || ''}
            onChange={(e) => setSelectedCity(e.target.value || null)}
            disabled={isBusy || citiesForState.length === 0}
          >
            <option value="">All cities in {selectedState || 'state'}</option>
            {citiesForState.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mb-5">
        <label className="block text-xs font-medium text-slate-500 mb-2">Quick pick</label>
        <div className="flex flex-wrap gap-2">
          {QUICK_PICKS.map((pick) => (
            <button
              key={pick}
              onClick={() => setNiche(pick)}
              className={`px-4 py-2 rounded-xl border text-sm font-medium transition disabled:opacity-50 ${
                niche === pick
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'border-slate-300 text-slate-700 hover:border-brand-400 dark:border-slate-600 dark:text-slate-300 dark:hover:border-brand-400'
              }`}
              disabled={isBusy}
            >
              {pick}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-5">
        <label className="block text-xs font-medium text-slate-500 mb-2" htmlFor="extraVariants">
          Extra keywords (optional, comma-separated)
        </label>
        <Input
          id="extraVariants"
          value={extraVariants}
          onChange={(e) => setExtraVariants(e.target.value)}
          placeholder="e.g. bakery, confectionery, cake shop"
          disabled={isBusy}
        />
      </div>
      <div className="flex flex-col md:flex-row md:items-end gap-4">
        <div className="md:w-64">
          <label className="block text-xs font-medium text-slate-500 mb-2" htmlFor="maxResults">
            Number of results
          </label>
          <Select id="maxResults" value={maxResults} onChange={(e) => setMaxResults(e.target.value)} disabled={isBusy}>
            {RESULT_OPTIONS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </Select>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none md:mb-3">
          <input
            type="checkbox"
            className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={deepSearch}
            onChange={(e) => setDeepSearch(e.target.checked)}
            disabled={isBusy}
          />
          Deep search (more keywords per area)
        </label>

        <div className="flex gap-2 md:ml-auto">
          <Button
            onClick={handleSearch}
            disabled={isBusy || !niche.trim() || !selectedState}
            loading={submitting}
            variant="primary"
            size="lg"
          >
            {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
            {submitting ? 'Starting…' : 'Search'}
          </Button>
          {isRunning && (
            <Button onClick={handleStop} variant="danger" size="lg">
              <StopCircle className="w-4 h-4" /> Stop
            </Button>
          )}
        </div>
      </div>

      {runId && progress && (niche.trim() !== (progress.niche || '') || selectedState !== (progress.state || '') || (selectedCity || null) !== (progress.city || null)) && (
        <p className="text-sm text-amber-600 dark:text-amber-400 mt-4">Form changed. Press Search to update.</p>
      )}

      {error && (
        <div className="mt-4 rounded-xl bg-red-50 border border-red-100 p-4 text-red-800 text-sm flex flex-wrap items-center gap-3 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          {stalled && (
            <Button onClick={retryConnection} variant="outline" size="sm">
              <RefreshCw className="w-3.5 h-3.5" /> Reconnect
            </Button>
          )}
        </div>
      )}
    </Card>
  );

  /* ---------- processing card ---------- */
  const processingCard = isRunning ? (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">
            Searching <span className="text-brand-700 dark:text-brand-400">{runNiche}</span> in {runLocation}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Results are saved as each city finishes. You can leave this page open.
          </p>
        </div>
        <Badge variant="running" size="md">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {status === 'queued' ? 'Queued' : 'Searching'}
        </Badge>
      </div>

      <div className="rounded-2xl p-5 mb-5 bg-brand-50 dark:bg-brand-900/20 border border-brand-100 dark:border-brand-900/40">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-5">
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 dark:text-slate-400">
              Contacts found
            </p>
            <p className="text-3xl font-bold text-brand-700 dark:text-brand-400 tabular-nums">
              {(progress?.resultCount ?? total).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 dark:text-slate-400">
              Searches completed
            </p>
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

        {progress?.level ? (
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <Badge variant="running" size="sm">
              Level {progress.level} of 4: {LEVEL_LABELS[progress.level] || ''}
            </Badge>
            <span className="text-slate-600 dark:text-slate-400">
              Provider: <b className="text-slate-800 dark:text-slate-200">{progress.currentProvider || 'gosom'}</b>
            </span>
          </div>
        ) : null}

        {progress?.providerCounts && progress.providerCounts.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-2">
            {progress.providerCounts.map((pc) => (
              <span
                key={pc.provider}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-600 text-xs font-medium dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300"
              >
                {pc.provider}: <b className="text-slate-800 dark:text-slate-200">{pc.new_contacts}</b> new
              </span>
            ))}
          </div>
        ) : null}

        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5 overflow-hidden">
          <div className="h-2.5 rounded-full bg-brand-600 transition-all duration-700" style={{ width: `${pct}%` }} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 mt-2">
          <span className="truncate max-w-[70%]">
            {totalTasks === 0 ? 'Preparing search queries…' : `Now: ${currentQuery}`}
          </span>
          <span>{pct}%</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          {workingTasks > 0 && (
            <Badge variant="running" size="sm">
              <Loader2 className="w-3 h-3 animate-spin" /> {workingTasks} running
            </Badge>
          )}
          {queuedTasks > 0 && (
            <Badge variant="queued" size="sm">{queuedTasks} queued</Badge>
          )}
          {okTasks > 0 && (
            <Badge variant="done" size="sm">{okTasks} done</Badge>
          )}
          {failedTasks > 0 && (
            <Badge variant="failed" size="sm">{failedTasks} failed</Badge>
          )}
        </div>

        {queuedTasks > 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
            The scraper works through searches one at a time, so a full state can take a while.
            Results appear here as each search finishes.
          </p>
        )}

        {totalTasks === 0 && (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 mb-4">
            <Loader2 className="w-4 h-4 animate-spin text-brand-500" />
            Setting up scraper jobs — the first results can take a few minutes to arrive.
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">Live results</h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">{total.toLocaleString()} contacts saved</span>
          </div>
          <Table minW="680px">
            <thead>
              <tr>
                <TableHeadCell>Business name</TableHeadCell>
                <TableHeadCell>Phone</TableHeadCell>
                <TableHeadCell>Email</TableHeadCell>
                <TableHeadCell>City</TableHeadCell>
                <TableHeadCell>Address</TableHeadCell>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {leads.map((lead, i) => (
                <tr key={`${lead.phone}-${i}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                  <TableBodyCell className="font-medium text-slate-800 dark:text-slate-200 max-w-[240px]">
                    {lead.name}
                  </TableBodyCell>
                  <TableBodyCell className="whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <a href={`tel:${lead.phone}`} className="text-brand-600 hover:underline font-medium dark:text-brand-400" title="Click to call">
                        {lead.phone}
                      </a>
                      <CopyButton value={lead.phone} />
                    </div>
                  </TableBodyCell>
                  <TableBodyCell className="text-slate-600 dark:text-slate-400 max-w-[220px]">
                    <span className="line-clamp-2" title={lead.emails || ''}>{lead.emails || '—'}</span>
                  </TableBodyCell>
                  <TableBodyCell className="text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {lead.city || '—'}
                  </TableBodyCell>
                  <TableBodyCell className="text-slate-500 dark:text-slate-400 max-w-[360px]">
                    <span className="line-clamp-2" title={lead.address}>{lead.address || '—'}</span>
                  </TableBodyCell>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-slate-400 dark:text-slate-500">
                    Waiting for the first results…
                  </td>
                </tr>
              )}
            </tbody>
          </Table>

          {total > 0 && (
            <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
              <div>
                Showing <b className="text-slate-800 dark:text-slate-200">{fromLabel(total, page)}</b>{'–'}
                <b className="text-slate-800 dark:text-slate-200">{toLabel(total, page)}</b> of{' '}
                <b className="text-slate-800 dark:text-slate-200">{total.toLocaleString()}</b> contacts
              </div>
              {Math.ceil(total / PAGE_SIZE) > 1 && (
                <div className="flex items-center gap-1">
                  <Button
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                    variant="outline"
                    size="sm"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  {pageNumbers(page, Math.ceil(total / PAGE_SIZE)).map((p) => (
                    <Button
                      key={p}
                      onClick={() => setPage(p)}
                      variant={p === page ? 'primary' : 'outline'}
                      size="sm"
                    >
                      {p}
                    </Button>
                  ))}
                  <Button
                    disabled={page >= Math.ceil(total / PAGE_SIZE)}
                    onClick={() => setPage(page + 1)}
                    variant="outline"
                    size="sm"
                    aria-label="Next page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  ) : null;

  /* ---------- finished card ---------- */
  const finishedCard = isFinished ? (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">
          {total.toLocaleString()} contacts for{' '}
          <span className="text-brand-700 dark:text-brand-400">{runNiche}</span> in {runLocation}
        </h2>
        <Badge variant={progress?.status === 'failed' ? 'failed' : 'done'} size="md" />
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400 mb-5">
        <span>
          Searches: <b className="text-slate-800 dark:text-slate-200">{doneTasks}</b> of {totalTasks} finished
          {failedTasks > 0 && <span className="text-red-600 dark:text-red-400"> ({failedTasks} failed)</span>}
        </span>
        <span>
          Finished in <b className="text-slate-800 dark:text-slate-200 tabular-nums">{elapsed}</b>
        </span>
        {duplicatesRemoved > 0 && <span>{duplicatesRemoved.toLocaleString()} duplicates removed</span>}
      </div>

      {progress?.status === 'done' && (
        <div className="rounded-xl bg-green-50 border border-green-200 p-4 mb-5 flex flex-wrap items-center gap-2 dark:bg-green-900/20 dark:border-green-800">
          <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
          <p className="text-sm font-semibold text-green-800 dark:text-green-400">
            Deep search complete — <span className="tabular-nums">{total.toLocaleString()}</span> contacts found
          </p>
          <p className="text-xs text-green-700/80 dark:text-green-400/80">
            {doneTasks} of {totalTasks} searches finished
            {progress.rawRows ? (
              <>
                {' · '}
                <span className="tabular-nums">{progress.rawRows.toLocaleString()}</span> raw collected
              </>
            ) : null}
            {progress.duplicatesRemoved ? (
              <>
                {' · '}
                <span className="tabular-nums">{progress.duplicatesRemoved.toLocaleString()}</span> duplicates removed
              </>
            ) : null}
          </p>
        </div>
      )}
      {progress?.status === 'stopped' && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-800 text-sm flex items-center gap-2 mb-4 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          This search was stopped before every city finished. Contacts collected so far are shown below.
        </div>
      )}
      {progress?.status === 'failed' && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-red-800 text-sm flex items-center gap-2 mb-4 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          The search failed before completing. Contacts collected so far are shown below.
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <Input
          className="w-full sm:w-72"
          placeholder="Filter by name, phone or address"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <div className="flex gap-2 sm:ml-auto">
          <Button
            onClick={() => api.downloadResults(runId!, 'xlsx')}
            disabled={total === 0}
            variant="outline"
          >
            <Download className="w-4 h-4" /> Excel
          </Button>
          <Button
            onClick={() => api.downloadResults(runId!, 'csv')}
            disabled={total === 0}
            variant="outline"
          >
            <ExternalLink className="w-4 h-4" /> CSV
          </Button>
          <Button
            onClick={() => {
              onRunChange(null);
              setProgress(null);
              setLeads([]);
              setTotal(0);
              setQuery('');
              setPage(1);
              setError(null);
            }}
            variant="outline"
          >
            <Search className="w-4 h-4" /> New search
          </Button>
        </div>
      </div>

      {total === 0 ? (
        <EmptyState
          icon={Search}
          title="No contacts found"
          subtitle="Try a broader niche, remove the city filter, or enable deep search."
        />
      ) : (
        <>
          <Table minW="680px">
            <thead>
              <tr>
                <TableHeadCell>Business name</TableHeadCell>
                <TableHeadCell>Phone</TableHeadCell>
                <TableHeadCell>Email</TableHeadCell>
                <TableHeadCell>City</TableHeadCell>
                <TableHeadCell>Address</TableHeadCell>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {leads.map((lead, i) => (
                <tr key={`${lead.phone}-${i}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                  <TableBodyCell className="font-medium text-slate-800 dark:text-slate-200 max-w-[240px]">{lead.name}</TableBodyCell>
                  <TableBodyCell className="whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <a href={`tel:${lead.phone}`} className="text-brand-600 hover:underline font-medium dark:text-brand-400" title="Click to call">
                        {lead.phone}
                      </a>
                      <CopyButton value={lead.phone} />
                    </div>
                  </TableBodyCell>
                  <TableBodyCell className="text-slate-600 dark:text-slate-400 max-w-[220px]">
                    <span className="line-clamp-2" title={lead.emails || ''}>{lead.emails || '—'}</span>
                  </TableBodyCell>
                  <TableBodyCell className="text-slate-600 dark:text-slate-400 whitespace-nowrap">{lead.city || '—'}</TableBodyCell>
                  <TableBodyCell className="text-slate-500 dark:text-slate-400 max-w-[360px]">
                    <span className="line-clamp-2" title={lead.address}>{lead.address || '—'}</span>
                  </TableBodyCell>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-slate-400 dark:text-slate-500">
                    {query ? 'No contacts match your filter.' : 'No contacts found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </Table>

          {total > 0 && (
            <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
              <div>
                Showing <b className="text-slate-800 dark:text-slate-200">{fromLabel(total, page)}</b>{'–'}
                <b className="text-slate-800 dark:text-slate-200">{toLabel(total, page)}</b> of{' '}
                <b className="text-slate-800 dark:text-slate-200">{total.toLocaleString()}</b> contacts
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
          )}
        </>
      )}
    </Card>
  ) : null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {searchCard}
      {processingCard}
      {finishedCard}

      {!runId && !error && (
        <Card padding="lg">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-4">
            <Search className="w-6 h-6 text-brand-600" />
          </div>
          <p className="text-slate-600 dark:text-slate-400 font-medium">Ready when you are</p>
          <p className="text-slate-400 text-sm mt-1 dark:text-slate-500">
            Pick a niche and a state above, then press Search. Results arrive city by city.
          </p>
        </Card>
      )}
    </div>
  );
}

function fromLabel(total: number, page: number): number {
  return total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
}
function toLabel(total: number, page: number): number {
  return Math.min(page * PAGE_SIZE, total);
}
