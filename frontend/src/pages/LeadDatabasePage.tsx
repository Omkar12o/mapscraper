/* ------------------------------------------------------------------ */
/* Lead database page                                                 */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Filter, Phone, Trash2, Users } from 'lucide-react';
import { api, type Lead } from '../lib/api';
import { Badge, Button, Card, CopyButton, EmptyState, SectionHeader, Skeleton, Table, TableBodyCell, TableHeadCell } from '../components/ui';

const PAGE_SIZE = 50;

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

interface LeadRow extends Lead {
  id: string;
  niche: string;
  created_at: string;
  phone_type: 'mobile' | 'landline';
}

interface LeadDatabasePageProps {}

export function LeadDatabasePage({}: LeadDatabasePageProps) {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filterState, setFilterState] = useState('');
  const [filterCity, setFilterCity] = useState('');
  const [filterNiche, setFilterNiche] = useState('');
  const [filterHasEmail, setFilterHasEmail] = useState('');
  const [filterPhoneType, setFilterPhoneType] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [states, setStates] = useState<string[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [niches, setNiches] = useState<string[]>([]);

  /* ---------- load metadata for filters ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Load states from leads endpoint (we'll derive from data below)
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- load leads ---------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(PAGE_SIZE),
          q: query,
        });
        if (filterState) params.set('state', filterState);
        if (filterCity) params.set('city', filterCity);
        if (filterNiche) params.set('niche', filterNiche);
        if (filterHasEmail) params.set('has_email', filterHasEmail);
        if (filterPhoneType) params.set('phone_type', filterPhoneType);
        if (filterFrom) params.set('from', filterFrom);
        if (filterTo) params.set('to', filterTo);

        const data = await api.getLeads(`?${params.toString()}`);
        if (!cancelled) {
          setLeads(data.rows);
          setTotal(data.total);
          setLoading(false);
          // Derive filter options from data
          const stateSet = new Set<string>();
          const citySet = new Set<string>();
          const nicheSet = new Set<string>();
          for (const r of data.rows) {
            if (r.state) stateSet.add(r.state);
            if (r.city) citySet.add(r.city);
            if (r.niche) nicheSet.add(r.niche);
          }
          setStates(Array.from(stateSet).sort());
          setCities(Array.from(citySet).sort());
          setNiches(Array.from(nicheSet).sort());
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, query, filterState, filterCity, filterNiche, filterHasEmail, filterPhoneType, filterFrom, filterTo]);

  /* ---------- derived ---------- */
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromIdx = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toIdx = Math.min(page * PAGE_SIZE, total);
  const isIndeterminate =
    selectedIds.size > 0 && selectedIds.size < leads.length;
  const allSelected = leads.length > 0 && selectedIds.size === leads.length;

  /* ---------- handlers ---------- */
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(leads.map((l) => l.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (!window.confirm(`Delete ${selectedIds.size} leads?`)) return;
    // Note: bulk delete per-run not supported via global API; removing from UI only
    setLeads((prev) => prev.filter((l) => !selectedIds.has(l.id)));
    setSelectedIds(new Set());
    setTotal((t) => t - selectedIds.size);
  };

  const handleExportSelected = async () => {
    if (selectedIds.size === 0) return;
    // Build download URL with selected IDs
    const ids = Array.from(selectedIds).join(',');
    const url = `${window.location.origin}/api/leads/export?ids=${encodeURIComponent(ids)}&format=xlsx`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selected-leads.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const phoneTypeBadge = (type: 'mobile' | 'landline') => {
    return type === 'mobile' ? (
      <Badge variant="done" size="sm">Mobile</Badge>
    ) : (
      <Badge variant="stopped" size="sm">Landline</Badge>
    );
  };

  const whatsappLink = (phone: string) => {
    const digits = String(phone).replace(/[^0-9]/g, '');
    return `https://wa.me/${digits}`;
  };

  if (loading)
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <SectionHeader title="Lead database" subtitle="All your collected contacts, de-duplicated by phone." />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} padding="md">
              <div className="flex items-center gap-3">
                <Skeleton h="32px" w="32px" />
                <div>
                  <Skeleton h="16px" w="60%" />
                  <Skeleton h="14px" w="40%" className="mt-2" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Header + actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div>
          <SectionHeader
            title="Lead database"
            subtitle="All your collected contacts, de-duplicated by phone. Server-side pagination, filters, and WhatsApp integration."
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => api.exportLeads('?format=xlsx')}
            variant="primary"
            size="sm"
          >
            <Download className="w-4 h-4" /> Download Excel
          </Button>
          <Button onClick={() => setPage(1)} variant="outline" size="sm">
            <RefreshIcon className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card padding="md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">Total leads</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">{total.toLocaleString()}</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-brand-50 flex items-center justify-center text-brand-600 dark:bg-brand-900/20 dark:text-brand-400">
              <Users className="w-5 h-5" />
            </div>
          </div>
        </Card>
        <Card padding="md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">With email</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">
                {leads.filter((l) => l.emails).length.toLocaleString()}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center text-green-600 dark:bg-green-900/20 dark:text-green-400">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          </div>
        </Card>
        <Card padding="md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider dark:text-slate-400">Mobile numbers</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">
                {leads.filter((l) => l.phone_type === 'mobile').length.toLocaleString()}
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">
              <Phone className="w-5 h-5" />
            </div>
          </div>
        </Card>
      </div>

      {/* Filters */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Filters</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div className="relative col-span-1 sm:col-span-2">
            <SearchIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search name, phone, address…"
              className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2.5 text-sm outline-none transition-colors
                focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
            />
          </div>
          <select
            value={filterState}
            onChange={(e) => {
              setFilterState(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={filterCity}
            onChange={(e) => {
              setFilterCity(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All cities</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={filterNiche}
            onChange={(e) => {
              setFilterNiche(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All niches</option>
            {niches.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <select
            value={filterHasEmail}
            onChange={(e) => {
              setFilterHasEmail(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All</option>
            <option value="true">Has email</option>
            <option value="false">No email</option>
          </select>
          <select
            value={filterPhoneType}
            onChange={(e) => {
              setFilterPhoneType(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All phones</option>
            <option value="mobile">Mobile</option>
            <option value="landline">Landline</option>
          </select>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => {
              setFilterFrom(e.target.value);
              setPage(1);
            }}
            className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
          <input
            type="date"
            value={filterTo}
            onChange={(e) => {
              setFilterTo(e.target.value);
              setPage(1);
            }}
            className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white text-slate-700
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Badge variant={filterState || filterCity || filterNiche || filterHasEmail || filterPhoneType || filterFrom || filterTo || query ? 'done' : 'stopped'} size="sm">
            {query || filterState || filterCity || filterNiche || filterHasEmail || filterPhoneType || filterFrom || filterTo ? 'Active filters' : 'No filters'}
          </Badge>
          <Button
            onClick={() => {
              setQuery('');
              setFilterState('');
              setFilterCity('');
              setFilterNiche('');
              setFilterHasEmail('');
              setFilterPhoneType('');
              setFilterFrom('');
              setFilterTo('');
              setPage(1);
            }}
            variant="outline"
            size="sm"
          >
            Clear all
          </Button>
        </div>
      </Card>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <Card padding="md">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {selectedIds.size} lead{selectedIds.size > 1 ? 's' : ''} selected
            </div>
            <div className="flex gap-2">
              <Button onClick={handleExportSelected} variant="primary" size="sm" disabled={selectedIds.size === 0}>
                <Download className="w-3.5 h-3.5" /> Export selected
              </Button>
              <Button onClick={handleBulkDelete} variant="danger" size="sm">
                <Trash2 className="w-3.5 h-3.5" /> Delete selected
              </Button>
              <Button
                onClick={() => setSelectedIds(new Set())}
                variant="outline"
                size="sm"
              >
                Clear selection
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Table */}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                </th>
                <TableHeadCell>Business name</TableHeadCell>
                <TableHeadCell>Phone</TableHeadCell>
                <TableHeadCell>Type</TableHeadCell>
                <TableHeadCell>Email</TableHeadCell>
                <TableHeadCell>Niche</TableHeadCell>
                <TableHeadCell>City</TableHeadCell>
                <TableHeadCell>State</TableHeadCell>
                <TableHeadCell className="text-right">Added</TableHeadCell>
                <TableHeadCell className="text-right">Action</TableHeadCell>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {leads.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-slate-400 dark:text-slate-500">
                    No leads found.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(lead.id)}
                        onChange={() => toggleSelect(lead.id)}
                        className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                    </td>
                    <TableBodyCell className="font-medium text-slate-800 dark:text-slate-200 max-w-[200px]">
                      {lead.name}
                    </TableBodyCell>
                    <TableBodyCell className="whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <a
                          href={`tel:${lead.phone}`}
                          className="text-brand-600 hover:underline font-medium dark:text-brand-400"
                          title="Click to call"
                        >
                          {lead.phone}
                        </a>
                        <CopyButton value={lead.phone} />
                        <a
                          href={whatsappLink(lead.phone)}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-green-600 transition dark:hover:bg-slate-800 dark:text-slate-500 dark:hover:text-green-400"
                          title="WhatsApp"
                        >
                          <span className="w-3.5 h-3.5">💬</span>
                        </a>
                      </div>
                    </TableBodyCell>
                    <TableBodyCell>{phoneTypeBadge(lead.phone_type)}</TableBodyCell>
                    <TableBodyCell className="text-slate-600 dark:text-slate-400 max-w-[180px]">
                      <span className="line-clamp-1" title={lead.emails || ''}>{lead.emails || '—'}</span>
                    </TableBodyCell>
                    <TableBodyCell className="text-slate-600 dark:text-slate-400">{lead.niche}</TableBodyCell>
                    <TableBodyCell className="text-slate-600 dark:text-slate-400">{lead.city || '—'}</TableBodyCell>
                    <TableBodyCell className="text-slate-600 dark:text-slate-400">{lead.state || '—'}</TableBodyCell>
                    <TableBodyCell className="text-slate-600 dark:text-slate-400 whitespace-nowrap text-right">
                      {formatDate(lead.created_at)}
                    </TableBodyCell>
                    <TableBodyCell className="text-right">
                      <Button
                        onClick={() => {
                          setSelectedIds(new Set([lead.id]));
                        }}
                        variant="outline"
                        size="sm"
                        className="min-w-[80px]"
                      >
                        Select
                      </Button>
                    </TableBodyCell>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
            <div>
              Showing <b className="text-slate-800 dark:text-slate-200">{fromIdx}</b>{'–'}
              <b className="text-slate-800 dark:text-slate-200">{toIdx}</b> of{' '}
              <b className="text-slate-800 dark:text-slate-200">{total.toLocaleString()}</b> leads
            </div>
            <div className="flex items-center gap-1">
              <Button
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
                variant="outline"
                size="sm"
              >
                <ChevronLeftIcon className="w-3.5 h-3.5" />
              </Button>
              {pageNumbers(page, totalPages).map((p) => (
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
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                variant="outline"
                size="sm"
              >
                <ChevronRightIcon className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
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

/* Icons used locally */
function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h5M14 4v5h-4m0 0v5h5M4 4l5 5m-5-5L9 9m0 0l5-5m-5 5l-5-5" />
    </svg>
  );
}
function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m21 21-5.197-5.197m0 0a7 7 0 11-9.9-9.9 7 7 0 019.9 9.9" />
    </svg>
  );
}
function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m15 18-6-6 6-6" />
    </svg>
  );
}
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m9 18 6-6-6-6" />
    </svg>
  );
}
