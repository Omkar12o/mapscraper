const API_BASE = (import.meta as any).env.VITE_API_BASE || '/api';

async function request(path: string, opts: RequestInit = {}): Promise<any> {
  let bodyText = '';
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    bodyText = await res.text().catch(() => '');
    let message = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      message = parsed.error || parsed.message || bodyText;
    } catch {
      /* keep raw text */
    }
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return bodyText;
}

export type StateOption = { code: string; name: string };

export type RunSummary = {
  id: string;
  niche: string;
  state: string;
  city: string | null;
  status: string;
  total_cities: number;
  completed_cities: number;
  failed_cities: number;
  result_count: number;
  created_at: string;
  max_results: number | null;
  deep_search: number;
  level: number;
  exhausted: boolean;
  provider_counts: { provider: string; new_contacts: number }[];
};

export type Progress = {
  id: string;
  niche: string;
  state: string;
  city: string | null;
  status: string;
  totalCities: number;
  completedCities: number;
  failedCities: number;
  resultCount: number;
  rawRows: number;
  duplicatesRemoved: number;
  currentArea: string | null;
  startedAt: string | null;
  deepSearch: number;
  level: number;
  currentProvider: string;
  providerCounts: { provider: string; new_contacts: number }[];
  byStatus: Record<string, number>;
};

export type Lead = {
  name: string;
  phone: string;
  address: string;
  state: string;
  city: string;
  emails?: string;
};

export type ResultsPage = {
  rows: Lead[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export const api = {
  getStates: (): Promise<StateOption[]> => request('/states'),
  getCities: (state: string): Promise<{ state: string; cities: string[]; areas?: string[] }> =>
    request(`/cities?state=${encodeURIComponent(state)}`),
  search: (body: {
    niche: string;
    state: string;
    city?: string | null;
    maxResults?: number | null;
    deepSearch?: boolean;
    extraVariants?: string[];
  }): Promise<{
    runId: string;
    state: string;
    totalCities: number;
    deepSearch: number;
    keywordVariants: number;
    busy?: boolean;
    activeRunId?: string | null;
  }> =>
    request('/search', { method: 'POST', body: JSON.stringify(body) }),
  getProgress: (runId: string): Promise<Progress> => request(`/runs/${encodeURIComponent(runId)}/progress`),
  clearStuck: (runId: string): Promise<{ cleared: number }> =>
    request(`/runs/${encodeURIComponent(runId)}/clear-stuck`, { method: 'POST' }),
  getResults: (
    runId: string,
    { page = 1, limit = 25, q = '', sort = 'name' }: { page?: number; limit?: number; q?: string; sort?: 'name' | 'recent' }
  ): Promise<ResultsPage> =>
    request(
      `/runs/${encodeURIComponent(runId)}/results?page=${page}&limit=${limit}&q=${encodeURIComponent(q)}&sort=${sort}`
    ),
  listRuns: (): Promise<RunSummary[]> => request('/runs'),
  getSettings: (): Promise<any[]> => request('/settings/providers'),
  saveSetting: (body: { provider: string; enabled?: boolean; apiKey?: string; limit?: number }) =>
    request('/settings/providers', { method: 'POST', body: JSON.stringify(body) }),
  testSetting: (provider: string, apiKey?: string) =>
    request('/settings/providers/test', { method: 'POST', body: JSON.stringify({ provider, apiKey }) }),
  resetQuota: (provider?: string) =>
    request('/settings/providers/reset-quota', { method: 'POST', body: JSON.stringify({ provider }) }),
  retryRun: (runId: string): Promise<{ retried: number }> =>
    request(`/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }),
  deleteRun: (runId: string) =>
    request(`/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
  deleteAllRuns: (): Promise<{ deleted: number }> => request('/runs', { method: 'DELETE' }),
  stopRun: (runId: string): Promise<{ stopped: boolean }> =>
    request(`/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }),
  getLeads: (queryString: string) =>
    request(`/leads${queryString.startsWith('?') ? queryString : '?' + queryString}`),
  exportLeads: (queryString: string) => {
    const url = `${API_BASE}/leads/export${queryString.startsWith('?') ? queryString : '?' + queryString}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leads.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },
  // Mail Finder
  searchMail: (body: {
    mode?: 'new' | 'contacts';
    sourceRunId?: string | null;
    niche: string;
    state: string;
    city?: string | null;
    maxResults?: number | null;
    deepSearch?: boolean;
    extraVariants?: string[];
  }): Promise<{ mailJobId: string; state: string; queued?: boolean }> =>
    request('/mail/search', { method: 'POST', body: JSON.stringify(body) }),
  getMailProgress: (mailJobId: string): Promise<any> =>
    request(`/mail/${encodeURIComponent(mailJobId)}/progress`),
  getMailResults: (
    mailJobId: string,
    {
      page = 1,
      limit = 50,
      q = '',
      filter = '',
      newOnly = false,
      showInvalid = false,
      city = null,
    }: { page?: number; limit?: number; q?: string; filter?: string; newOnly?: boolean; showInvalid?: boolean; city?: string | null }
  ): Promise<any> =>
    request(
      `/mail/${encodeURIComponent(mailJobId)}/results?page=${page}&limit=${limit}&q=${encodeURIComponent(q)}` +
        `${filter ? `&filter=${encodeURIComponent(filter)}` : ''}` +
        `${newOnly ? '&new_only=true' : ''}` +
        `${showInvalid ? '&show_invalid=true' : ''}` +
        `${city ? `&city=${encodeURIComponent(city)}` : ''}`
    ),
  getMailSources: (): Promise<any[]> => request('/mail/sources'),
  getMailJobs: (): Promise<any[]> => request('/mail/jobs'),
  deleteMailJob: (mailJobId: string) =>
    request(`/mail/${encodeURIComponent(mailJobId)}`, { method: 'DELETE' }),
  deleteAllMailJobs: (): Promise<{ deleted: number }> => request('/mail', { method: 'DELETE' }),
  stopMailJob: (mailJobId: string): Promise<{ stopped: boolean }> =>
    request(`/mail/${encodeURIComponent(mailJobId)}/stop`, { method: 'POST' }),
  downloadMailResults: (
    mailJobId: string,
    format: 'csv' | 'xlsx' = 'xlsx',
    opts: { columns?: string[]; splitBy?: '' | 'city' | 'state'; showInvalid?: boolean; city?: string | null; q?: string; filter?: string; newOnly?: boolean } = {}
  ) => {
    const params = new URLSearchParams();
    params.set('format', format);
    if (opts.columns && opts.columns.length) params.set('columns', opts.columns.join(','));
    if (opts.splitBy) params.set('split_by', opts.splitBy);
    if (opts.showInvalid) params.set('show_invalid', 'true');
    if (opts.city) params.set('city', opts.city);
    if (opts.q) params.set('q', opts.q);
    if (opts.filter) params.set('filter', opts.filter);
    if (opts.newOnly) params.set('new_only', 'true');
    const url = `${API_BASE}/mail/${encodeURIComponent(mailJobId)}/download?${params.toString()}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'xlsx' ? 'MailFinder.xlsx' : 'MailFinder.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },
  downloadResults: (runId: string, format: 'csv' | 'xlsx') => {
    const url = `${API_BASE}/runs/${encodeURIComponent(runId)}/download?format=${format}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'xlsx' ? 'leads.xlsx' : 'leads.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  // WhatsApp bulk sender (Baileys)
  getWhatsAppStatus: (): Promise<any> => request('/whatsapp/status'),
  connectWhatsApp: (): Promise<any> => request('/whatsapp/connect', { method: 'POST' }),
  logoutWhatsApp: (): Promise<any> => request('/whatsapp/logout', { method: 'POST' }),
  previewWhatsAppRecipients: (opts: { state?: string; city?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts.state) params.set('state', opts.state);
    if (opts.city) params.set('city', opts.city);
    if (opts.limit) params.set('limit', String(opts.limit));
    return request(`/whatsapp/recipients?${params.toString()}`);
  },
  startWhatsAppCampaign: (body: {
    template: string;
    state?: string;
    city?: string;
    delaySeconds?: number;
    dailyCap?: number;
    limit?: number;
  }): Promise<{ jobId: string; total: number }> =>
    request('/whatsapp/send', { method: 'POST', body: JSON.stringify(body) }),
  listWhatsAppJobs: (): Promise<any[]> => request('/whatsapp/jobs'),
  getWhatsAppJob: (jobId: string, page = 1, limit = 50): Promise<any> =>
    request(`/whatsapp/jobs/${encodeURIComponent(jobId)}?page=${page}&limit=${limit}`),
  stopWhatsAppJob: (jobId: string): Promise<{ stopped: boolean }> =>
    request(`/whatsapp/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST' }),
  resumeWhatsAppJob: (jobId: string): Promise<{ resumed: boolean }> =>
    request(`/whatsapp/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }),
  deleteWhatsAppJob: (jobId: string) =>
    request(`/whatsapp/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  getWhatsAppBlacklist: (): Promise<any[]> => request('/whatsapp/blacklist'),
  addWhatsAppBlacklist: (phone: string, reason?: string) =>
    request('/whatsapp/blacklist', { method: 'POST', body: JSON.stringify({ phone, reason }) }),
  removeWhatsAppBlacklist: (phone: string) =>
    request(`/whatsapp/blacklist/${encodeURIComponent(phone)}`, { method: 'DELETE' }),
};
