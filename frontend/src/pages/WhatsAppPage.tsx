/* ------------------------------------------------------------------ */
/* WhatsApp Sender — Baileys QR login + bulk campaign with rate limits */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  LogOut,
  MessageCircle,
  Play,
  QrCode,
  RefreshCw,
  Send,
  ShieldOff,
  Square,
  Trash2,
} from 'lucide-react';
import { api, StateOption } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  Table,
  TableBodyCell,
  TableHeadCell,
  useToast,
  type StatusVariant,
} from '../components/ui';

const CONN_BADGE: Record<string, StatusVariant> = {
  connected: 'done',
  qr: 'queued',
  connecting: 'running',
  reconnecting: 'partly',
  disconnected: 'stopped',
  logged_out: 'failed',
  error: 'failed',
};

const JOB_BADGE: Record<string, StatusVariant> = {
  running: 'running',
  paused: 'partly',
  capped: 'partly',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
};

const MSG_BADGE: Record<string, StatusVariant> = {
  sent: 'done',
  pending: 'queued',
  sending: 'running',
  failed: 'failed',
};

function badgeLabel(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '—';
}

export function WhatsAppPage() {
  const { add } = useToast();

  const [status, setStatus] = useState<any>(null);
  const [states, setStates] = useState<StateOption[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [blacklist, setBlacklist] = useState<any[]>([]);

  const [formState, setFormState] = useState('');
  const [city, setCity] = useState('');
  const [template, setTemplate] = useState(
    'Hi {name}, I found your business in {city}. We help local businesses get more customers online. Reply YES if you would like details.'
  );
  const [delaySeconds, setDelaySeconds] = useState(45);
  const [dailyCap, setDailyCap] = useState(100);
  const [limit, setLimit] = useState(50);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);

  const [newPhone, setNewPhone] = useState('');
  const [newReason, setNewReason] = useState('');

  const [testPhone, setTestPhone] = useState('');
  const [testName, setTestName] = useState('');
  const [testMessage, setTestMessage] = useState(
    'Test message from Lead Finder. If you received this, WhatsApp sending is working.'
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.getWhatsAppStatus());
    } catch {
      /* backend not reachable yet */
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await api.listWhatsAppJobs();
      setJobs(rows);
      setSelectedId((prev) => {
        if (prev) return prev;
        const active = rows.find((j: any) => j.status === 'running' || j.status === 'paused');
        return active ? active.id : null;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const loadBlacklist = useCallback(async () => {
    try {
      setBlacklist(await api.getWhatsAppBlacklist());
    } catch {
      /* ignore */
    }
  }, []);

  const loadDetail = useCallback(async (jobId: string) => {
    try {
      setDetail(await api.getWhatsAppJob(jobId, 1, 100));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    api.getStates().then(setStates).catch(() => {});
    loadJobs();
    loadBlacklist();
  }, [refreshStatus, loadJobs, loadBlacklist]);

  useEffect(() => {
    const id = window.setInterval(refreshStatus, 3000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    const id = window.setInterval(loadJobs, 5000);
    return () => window.clearInterval(id);
  }, [loadJobs]);

  useEffect(() => {
    if (!formState) {
      setCities([]);
      return;
    }
    api
      .getCities(formState)
      .then((r) => setCities(r.cities || []))
      .catch(() => setCities([]));
  }, [formState]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId);
    const id = window.setInterval(() => loadDetail(selectedId), 3000);
    return () => window.clearInterval(id);
  }, [selectedId, loadDetail]);

  const connected = status?.status === 'connected';
  const activeJob = useMemo(
    () => jobs.find((j) => j.status === 'running' || j.status === 'paused') || null,
    [jobs]
  );

  const handleConnect = async () => {
    setBusy(true);
    try {
      const st = await api.connectWhatsApp();
      setStatus(st);
      add({ type: 'info', title: 'Connecting…', message: 'Scan the QR code with WhatsApp when it appears.' });
    } catch (err: any) {
      add({ type: 'error', title: 'Connection failed', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (!window.confirm('Log out of WhatsApp? The saved session will be deleted.')) return;
    setBusy(true);
    try {
      setStatus(await api.logoutWhatsApp());
      add({ type: 'success', title: 'Logged out' });
    } catch (err: any) {
      add({ type: 'error', title: 'Logout failed', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleSendTest = async () => {
    if (!connected) {
      add({ type: 'warning', title: 'Not connected', message: 'Scan the QR code first.' });
      return;
    }
    if (!testPhone.trim()) {
      add({ type: 'warning', title: 'No number', message: 'Enter the phone number to test with.' });
      return;
    }
    if (!testMessage.trim()) {
      add({ type: 'warning', title: 'Empty message', message: 'Write a test message first.' });
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.sendWhatsAppTest({
        phone: testPhone.trim(),
        template: testMessage,
        name: testName.trim(),
      });
      setTestResult({ ok: true, ...res });
      add({
        type: 'success',
        title: 'Test message sent',
        message: `Check +${res.phone} on your phone.`,
      });
      await refreshStatus();
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
      add({ type: 'error', title: 'Test failed', message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handlePreview = async () => {
    setPreviewLoading(true);
    try {
      setPreview(
        await api.previewWhatsAppRecipients({ state: formState, city: city.trim(), limit })
      );
    } catch (err: any) {
      add({ type: 'error', title: 'Preview failed', message: err.message });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStart = async () => {
    if (!connected) {
      add({ type: 'warning', title: 'Not connected', message: 'Scan the QR code first.' });
      return;
    }
    if (!template.trim()) {
      add({ type: 'warning', title: 'Empty message', message: 'Write a message template first.' });
      return;
    }
    setStarting(true);
    try {
      const res = await api.startWhatsAppCampaign({
        template,
        state: formState,
        city: city.trim(),
        delaySeconds,
        dailyCap,
        limit,
      });
      add({
        type: 'success',
        title: 'Campaign started',
        message: `${res.total} messages queued at ~${delaySeconds}s apart.`,
      });
      setSelectedId(res.jobId);
      await loadJobs();
      await loadDetail(res.jobId);
    } catch (err: any) {
      add({ type: 'error', title: 'Could not start', message: err.message });
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    if (!activeJob) return;
    if (!window.confirm('Stop this campaign? Pending messages will not be sent.')) return;
    try {
      await api.stopWhatsAppJob(activeJob.id);
      add({ type: 'success', title: 'Campaign stopped' });
      await loadJobs();
      await loadDetail(activeJob.id);
    } catch (err: any) {
      add({ type: 'error', title: 'Stop failed', message: err.message });
    }
  };

  const handleResume = async () => {
    if (!activeJob) return;
    try {
      await api.resumeWhatsAppJob(activeJob.id);
      add({ type: 'success', title: 'Campaign resumed' });
      await loadJobs();
      await loadDetail(activeJob.id);
    } catch (err: any) {
      add({ type: 'error', title: 'Resume failed', message: err.message });
    }
  };

  const handleAddBlacklist = async () => {
    if (!newPhone.trim()) return;
    try {
      await api.addWhatsAppBlacklist(newPhone.trim(), newReason.trim());
      setNewPhone('');
      setNewReason('');
      add({ type: 'success', title: 'Number blacklisted' });
      await loadBlacklist();
    } catch (err: any) {
      add({ type: 'error', title: 'Could not blacklist', message: err.message });
    }
  };

  const handleRemoveBlacklist = async (phone: string) => {
    try {
      await api.removeWhatsAppBlacklist(phone);
      await loadBlacklist();
    } catch (err: any) {
      add({ type: 'error', title: 'Could not remove', message: err.message });
    }
  };

  const job = detail?.job || (selectedId ? jobs.find((j) => j.id === selectedId) : null) || null;
  const counts = detail?.counts || {};
  const doneCount = (counts.sent || 0) + (counts.failed || 0);
  const pct = job?.total ? Math.min(100, Math.round((doneCount / job.total) * 100)) : 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="WhatsApp Sender"
        subtitle="Bulk message your saved leads through WhatsApp Web (Baileys), with delays and a daily cap."
      />

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">Unofficial API — use responsibly</p>
          <p className="mt-1">
            WhatsApp can ban numbers that send bulk or unsolicited messages. Only message people who agreed to be
            contacted, keep the delay at 30–60s or more, and stay under ~100 messages/day. Use a dedicated number.
          </p>
        </div>
      </div>

      {/* Connection */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-brand-600 dark:text-brand-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-semibold text-slate-900 dark:text-white">Connection</p>
                <Badge variant={CONN_BADGE[status?.status] || 'stopped'}>
                  {badgeLabel(status?.status || 'disconnected')}
                </Badge>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {connected
                  ? `Connected as +${status?.phone || '—'} • ${status?.todaySent ?? 0} sent today`
                  : status?.lastError
                  ? status.lastError
                  : 'Scan the QR code to link your WhatsApp account.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!connected && (
              <Button onClick={handleConnect} loading={busy}>
                <QrCode className="w-4 h-4" /> {status?.status === 'qr' ? 'Refresh QR' : 'Connect'}
              </Button>
            )}
            <Button variant="outline" onClick={refreshStatus}>
              <RefreshCw className="w-4 h-4" /> Refresh
            </Button>
            {(connected || status?.status === 'qr') && (
              <Button variant="danger" onClick={handleLogout} loading={busy}>
                <LogOut className="w-4 h-4" /> {connected ? 'Logout' : 'Cancel'}
              </Button>
            )}
          </div>
        </div>

        {status?.status === 'qr' && status?.qr && (
          <div className="mt-5 flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-6 dark:border-slate-700 dark:bg-slate-800/40">
            <img src={status.qr} alt="WhatsApp QR code" className="w-64 h-64 rounded-lg bg-white p-2" />
            <p className="text-sm text-slate-600 dark:text-slate-300 text-center">
              WhatsApp → <span className="font-medium">Linked devices</span> →{' '}
              <span className="font-medium">Link a device</span>, then scan this code.
            </p>
          </div>
        )}

        {connected && (
          <div className="mt-4 flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="w-4 h-4" /> Ready to send.
          </div>
        )}
      </Card>

      {/* Test message */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Test message</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Send one real WhatsApp message to a number you control before starting a campaign.
              Test sends do not count toward the daily cap or campaign history.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Phone number
            </label>
            <Input
              placeholder="+91XXXXXXXXXX"
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Name (optional, replaces {'{name}'})
            </label>
            <Input
              placeholder="Your name"
              value={testName}
              onChange={(e) => setTestName(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              Test message
            </label>
            <Button variant="ghost" size="sm" onClick={() => setTestMessage(template)}>
              Use campaign template
            </Button>
          </div>
          <textarea
            value={testMessage}
            onChange={(e) => setTestMessage(e.target.value)}
            rows={3}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition-colors placeholder-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={handleSendTest} loading={testing} disabled={!connected}>
            <Send className="w-4 h-4" /> Send test message
          </Button>
          {!connected && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Connect WhatsApp to run the test.
            </span>
          )}
        </div>

        {testResult && (
          <div
            className={`mt-4 rounded-xl border p-3 text-sm ${
              testResult.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-900/20 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-300'
            }`}
          >
            {testResult.ok ? (
              <p>
                Sent to <span className="font-semibold">+{testResult.phone}</span>. Open WhatsApp on
                that phone to confirm it arrived.
              </p>
            ) : (
              <p>Test failed: {testResult.error}</p>
            )}
          </div>
        )}
      </Card>

      {/* Campaign builder */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900 dark:text-white">New campaign</h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {preview ? `${preview.selected} eligible contacts` : 'Preview recipients before sending'}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">State</label>
            <Select value={formState} onChange={(e) => setFormState(e.target.value)}>
              <option value="">All states</option>
              {states.map((s) => (
                <option key={s.code} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">City (optional)</label>
            <Input
              list="wa-cities"
              placeholder="e.g. Pune"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
            <datalist id="wa-cities">
              {cities.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Max recipients (0 = all)
            </label>
            <Input
              type="number"
              min={0}
              max={5000}
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value || '0', 10))}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            Message template — use {'{name}'}, {'{city}'}, {'{state}'}, {'{phone}'}
          </label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={4}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition-colors placeholder-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Delay between messages (seconds)
            </label>
            <Input
              type="number"
              min={5}
              max={600}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(parseInt(e.target.value || '45', 10))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Daily cap (all campaigns)
            </label>
            <Input
              type="number"
              min={1}
              max={1000}
              value={dailyCap}
              onChange={(e) => setDailyCap(parseInt(e.target.value || '100', 10))}
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={handlePreview} loading={previewLoading}>
            <RefreshCw className="w-4 h-4" /> Preview recipients
          </Button>
          <Button onClick={handleStart} loading={starting} disabled={!connected || !!activeJob}>
            <Send className="w-4 h-4" /> Start campaign
          </Button>
          {!connected && <span className="text-xs text-slate-500">Connect WhatsApp to send.</span>}
          {activeJob && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              A campaign is already running — stop it to start another.
            </span>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              <span className="font-semibold">{preview.selected}</span> contacts selected
              {preview.matched !== preview.selected && (
                <span className="text-slate-500"> (of {preview.matched} eligible before the limit)</span>
              )}
            </p>
            {preview.sample?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {preview.sample.map((r: any) => (
                  <span
                    key={r.phone}
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {r.name || 'Unknown'} • +{r.phone}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Active campaign */}
      {job && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-slate-900 dark:text-white">Campaign</h3>
                <Badge variant={JOB_BADGE[job.status] || 'stopped'}>{badgeLabel(job.status)}</Badge>
              </div>
              <p className="text-xs text-slate-500 mt-1 dark:text-slate-400">
                {job.sent} sent • {job.failed} failed • {job.total} total • delay {job.delay_seconds}s • cap{' '}
                {job.daily_cap}/day
              </p>
              {job.error && <p className="text-xs text-red-600 mt-1">{job.error}</p>}
            </div>
            <div className="flex items-center gap-2">
              {(job.status === 'running' || job.status === 'paused') && (
                <Button variant="danger" size="sm" onClick={handleStop}>
                  <Square className="w-4 h-4" /> Stop
                </Button>
              )}
              {(job.status === 'paused' || job.status === 'capped' || job.status === 'stopped') && (
                <Button variant="outline" size="sm" onClick={handleResume} disabled={!connected}>
                  <Play className="w-4 h-4" /> Resume
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4">
            <div className="h-2.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-600 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              {doneCount} / {job.total} processed ({pct}%)
            </p>
          </div>

          {detail?.messages?.length > 0 && (
            <div className="mt-4">
              <Table>
                <thead>
                  <tr>
                    <TableHeadCell>Name</TableHeadCell>
                    <TableHeadCell>Phone</TableHeadCell>
                    <TableHeadCell>Status</TableHeadCell>
                    <TableHeadCell>Error</TableHeadCell>
                  </tr>
                </thead>
                <tbody>
                  {detail.messages.slice(0, 50).map((m: any) => (
                    <tr key={m.id}>
                      <TableBodyCell>{m.name || '—'}</TableBodyCell>
                      <TableBodyCell>+{m.phone}</TableBodyCell>
                      <TableBodyCell>
                        <Badge variant={MSG_BADGE[m.status] || 'queued'} size="sm">
                          {badgeLabel(m.status)}
                        </Badge>
                      </TableBodyCell>
                      <TableBodyCell>
                        <span className="text-xs text-red-600">{m.error || ''}</span>
                      </TableBodyCell>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {detail.total > detail.messages.length && (
                <p className="mt-2 text-xs text-slate-500">Showing first {detail.messages.length} of {detail.total}.</p>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Recent campaigns */}
      <Card padding="none">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
          <h3 className="font-semibold text-slate-900 dark:text-white">Recent campaigns</h3>
          <Button variant="ghost" size="sm" onClick={loadJobs}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
        </div>
        {jobs.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={MessageCircle}
              title="No campaigns yet"
              subtitle="Connect WhatsApp, pick your leads, and send your first campaign."
            />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <TableHeadCell>Started</TableHeadCell>
                <TableHeadCell>Status</TableHeadCell>
                <TableHeadCell>Progress</TableHeadCell>
                <TableHeadCell>Sent</TableHeadCell>
                <TableHeadCell>Failed</TableHeadCell>
                <TableHeadCell>{''}</TableHeadCell>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j: any) => (
                <tr key={j.id} className={j.id === selectedId ? 'bg-brand-50/40 dark:bg-brand-900/10' : ''}>
                  <TableBodyCell>{new Date(j.created_at).toLocaleString()}</TableBodyCell>
                  <TableBodyCell>
                    <Badge variant={JOB_BADGE[j.status] || 'stopped'} size="sm">
                      {badgeLabel(j.status)}
                    </Badge>
                  </TableBodyCell>
                  <TableBodyCell>
                    {j.sent + j.failed} / {j.total}
                  </TableBodyCell>
                  <TableBodyCell>{j.sent}</TableBodyCell>
                  <TableBodyCell>{j.failed}</TableBodyCell>
                  <TableBodyCell>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedId(j.id)}>
                      View
                    </Button>
                  </TableBodyCell>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Blacklist */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <ShieldOff className="w-4 h-4 text-slate-500" />
          <h3 className="font-semibold text-slate-900 dark:text-white">Do-not-contact list</h3>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Numbers here are skipped by every campaign. Add anyone who asks you to stop.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Phone</label>
            <Input placeholder="+91XXXXXXXXXX" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Reason (optional)
            </label>
            <Input placeholder="asked to stop" value={newReason} onChange={(e) => setNewReason(e.target.value)} />
          </div>
          <Button variant="outline" onClick={handleAddBlacklist}>
            <ShieldOff className="w-4 h-4" /> Add
          </Button>
        </div>

        {blacklist.length > 0 && (
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <TableHeadCell>Phone</TableHeadCell>
                  <TableHeadCell>Reason</TableHeadCell>
                  <TableHeadCell>Added</TableHeadCell>
                  <TableHeadCell>{''}</TableHeadCell>
                </tr>
              </thead>
              <tbody>
                {blacklist.map((b: any) => (
                  <tr key={b.phone}>
                    <TableBodyCell>+{b.phone}</TableBodyCell>
                    <TableBodyCell>{b.reason || '—'}</TableBodyCell>
                    <TableBodyCell>{new Date(b.created_at).toLocaleDateString()}</TableBodyCell>
                    <TableBodyCell>
                      <Button variant="ghost" size="sm" onClick={() => handleRemoveBlacklist(b.phone)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableBodyCell>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
