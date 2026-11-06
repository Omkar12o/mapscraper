/* ------------------------------------------------------------------ */
/* Mail Sender — SMTP campaigns with delays, daily cap and opt-outs.   */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Inbox,
  Mail,
  Play,
  RefreshCw,
  Send,
  Settings,
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

export function MailSenderPage() {
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
  const [subject, setSubject] = useState('Quick question about {business}');
  const [template, setTemplate] = useState(
    'Hi {name},\n\nI found {business} while looking at businesses in {city}. We help local businesses get more customers online.\n\nWould you be open to a quick chat?\n\nThanks'
  );
  const [delaySeconds, setDelaySeconds] = useState(45);
  const [dailyCap, setDailyCap] = useState(50);
  const [limit, setLimit] = useState(25);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpReplyTo, setSmtpReplyTo] = useState('');
  const [smtpUnsub, setSmtpUnsub] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [newReason, setNewReason] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.getMailSenderStatus());
    } catch {
      /* backend not reachable yet */
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await api.listMailSenderJobs();
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
      setBlacklist(await api.getMailSenderBlacklist());
    } catch {
      /* ignore */
    }
  }, []);

  const loadDetail = useCallback(async (jobId: string) => {
    try {
      setDetail(await api.getMailSenderJob(jobId, 1, 100));
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
    const id = window.setInterval(refreshStatus, 5000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    const id = window.setInterval(loadJobs, 5000);
    return () => window.clearInterval(id);
  }, [loadJobs]);

  useEffect(() => {
    if (status?.defaultDelaySeconds) setDelaySeconds(status.defaultDelaySeconds);
    if (status?.defaultDailyCap) setDailyCap(status.defaultDailyCap);
  }, [status?.defaultDelaySeconds, status?.defaultDailyCap]);

  useEffect(() => {
    if (!status || settingsLoaded) return;
    setSmtpHost(status.host || '');
    setSmtpPort(status.port || 587);
    setSmtpSecure(!!status.secure);
    setSmtpUser('');
    setSmtpFrom(status.from || '');
    setSmtpReplyTo(status.replyTo || '');
    setSmtpUnsub(status.unsubscribeUrl || '');
    setSettingsLoaded(true);
  }, [status, settingsLoaded]);

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

  const configured = !!status?.configured;
  const activeJob = useMemo(
    () => jobs.find((j) => j.status === 'running' || j.status === 'paused') || null,
    [jobs]
  );

  const handleTest = async () => {
    if (!configured) {
      add({ type: 'warning', title: 'Not configured', message: 'Add SMTP settings first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testMailSender(testTo.trim());
      setTestResult({ ok: true, ...res });
      add({ type: 'success', title: 'Test email sent', message: `Check ${res.to}.` });
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
      add({ type: 'error', title: 'Test failed', message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await api.saveMailSenderConfig({
        host: smtpHost,
        port: Number(smtpPort) || 587,
        secure: smtpSecure,
        user: smtpUser,
        pass: smtpPass,
        from: smtpFrom,
        replyTo: smtpReplyTo,
        unsubscribeUrl: smtpUnsub,
      });
      setStatus(res);
      setSmtpPass('');
      setSettingsLoaded(false);
      add({
        type: 'success',
        title: 'SMTP settings saved',
        message: 'Now use “Send test email” to confirm the login.',
      });
    } catch (err: any) {
      add({ type: 'error', title: 'Could not save', message: err.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleClearSettings = async () => {
    if (!window.confirm('Remove the saved SMTP settings? Environment variables are not affected.')) {
      return;
    }
    try {
      const res = await api.clearMailSenderConfig();
      setStatus(res);
      setSmtpPass('');
      setSettingsLoaded(false);
      add({ type: 'success', title: 'Saved settings removed' });
    } catch (err: any) {
      add({ type: 'error', title: 'Could not remove', message: err.message });
    }
  };

  const handlePreview = async () => {
    setPreviewLoading(true);
    try {
      setPreview(
        await api.previewMailRecipients({ state: formState, city: city.trim(), limit })
      );
    } catch (err: any) {
      add({ type: 'error', title: 'Preview failed', message: err.message });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStart = async () => {
    if (!configured) {
      add({ type: 'warning', title: 'Not configured', message: 'Add SMTP settings first.' });
      return;
    }
    if (!subject.trim()) {
      add({ type: 'warning', title: 'No subject', message: 'Write a subject first.' });
      return;
    }
    if (!template.trim()) {
      add({ type: 'warning', title: 'Empty message', message: 'Write a message template first.' });
      return;
    }
    setStarting(true);
    try {
      const res = await api.startMailCampaign({
        subject,
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
        message: `${res.total} emails queued at ~${delaySeconds}s apart.`,
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
    if (!window.confirm('Stop this campaign? Pending emails will not be sent.')) return;
    try {
      await api.stopMailSenderJob(activeJob.id);
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
      await api.resumeMailSenderJob(activeJob.id);
      add({ type: 'success', title: 'Campaign resumed' });
      await loadJobs();
      await loadDetail(activeJob.id);
    } catch (err: any) {
      add({ type: 'error', title: 'Resume failed', message: err.message });
    }
  };

  const handleAddBlacklist = async () => {
    if (!newEmail.trim()) return;
    try {
      await api.addMailSenderBlacklist(newEmail.trim(), newReason.trim());
      setNewEmail('');
      setNewReason('');
      add({ type: 'success', title: 'Email opted out' });
      await loadBlacklist();
    } catch (err: any) {
      add({ type: 'error', title: 'Could not add', message: err.message });
    }
  };

  const handleRemoveBlacklist = async (email: string) => {
    try {
      await api.removeMailSenderBlacklist(email);
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
        title="Mail Sender"
        subtitle="Email the addresses found by Mail Finder over your own SMTP account, with delays, a daily cap and an opt-out list."
      />

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">Cold email rules</p>
          <p className="mt-1">
            Only email businesses you have a legitimate reason to contact, include a real opt-out,
            and keep volume low. Use a separate sending domain (not your main inbox), warm it up,
            and set up SPF, DKIM and DMARC. Provider limits are typically 20–50/day per mailbox for
            cold outreach.
          </p>
        </div>
      </div>

      {/* SMTP setup + test */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center">
              <Mail className="w-5 h-5 text-brand-600 dark:text-brand-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-semibold text-slate-900 dark:text-white">SMTP account</p>
                <Badge variant={configured ? 'done' : 'failed'}>
                  {configured ? 'Configured' : 'Not configured'}
                </Badge>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {configured
                  ? `Sending as ${status?.from} via ${status?.host}:${status?.port} • ${
                      status?.todaySent ?? 0
                    } sent today${status?.source === 'env' ? ' (environment variables)' : ''}`
                  : 'Enter your SMTP details below, save, then send a test email.'}
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={refreshStatus}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowSettings((v) => !v)}>
            <Settings className="w-4 h-4" />{' '}
            {showSettings ? 'Hide settings' : configured ? 'Edit settings' : 'Configure SMTP'}
          </Button>
          {status?.source === 'file' && (
            <Button variant="ghost" size="sm" onClick={handleClearSettings}>
              <Trash2 className="w-4 h-4" /> Remove saved settings
            </Button>
          )}
          {status?.source === 'env' && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Environment variables override saved settings.
            </span>
          )}
        </div>

        {(showSettings || !configured) && (
          <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  SMTP host
                </label>
                <Input
                  placeholder="smtp.gmail.com"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                />
                {smtpHost.includes('@') ? (
                  <p className="mt-1 text-[11px] font-medium text-red-600 dark:text-red-400">
                    That is an email address. Enter the mail server instead — for Gmail use{' '}
                    <code>smtp.gmail.com</code>.
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Server name only, e.g. <code>smtp.gmail.com</code> — not your email address.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Port
                </label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(parseInt(e.target.value || '587', 10))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Username
                </label>
                <Input
                  placeholder={status?.hasAuth ? 'Saved — leave blank to keep' : 'you@gmail.com'}
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Password / app password
                </label>
                <Input
                  type="password"
                  placeholder={
                    status?.hasPassword ? 'Saved — leave blank to keep' : '16-character app password'
                  }
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  From address
                </label>
                <Input
                  placeholder="Lead Finder <you@gmail.com>"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Leave blank to use the username. Both <code>you@gmail.com</code> and{' '}
                  <code>Your Name &lt;you@gmail.com&gt;</code> work.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Reply-To (optional)
                </label>
                <Input
                  placeholder="you@example.com"
                  value={smtpReplyTo}
                  onChange={(e) => setSmtpReplyTo(e.target.value)}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Unsubscribe URL (optional)
                </label>
                <Input
                  placeholder="https://your-site.com/unsubscribe"
                  value={smtpUnsub}
                  onChange={(e) => setSmtpUnsub(e.target.value)}
                />
              </div>
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={smtpSecure}
                onChange={(e) => setSmtpSecure(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Use implicit TLS (usually port 465)
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={handleSaveSettings} loading={savingSettings}>
                <Settings className="w-4 h-4" /> Save settings
              </Button>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Saved locally to <code>backend/data/mail-config.json</code>; the password is never
                returned to the browser.
              </span>
            </div>

            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Gmail needs an App Password (2-Step Verification). Brevo, Resend, SendGrid, Mailgun
              and Amazon SES also work through SMTP. You can also set these values in{' '}
              <code>backend/.env</code> and restart.
            </p>
          </div>
        )}

        <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <h3 className="font-semibold text-slate-900 dark:text-white">Test email</h3>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Send one real test email to yourself. Test emails do not count toward the daily cap or
            campaign history.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                Send to
              </label>
              <Input
                placeholder="you@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </div>
            <Button onClick={handleTest} loading={testing} disabled={!configured}>
              <Send className="w-4 h-4" /> Send test email
            </Button>
          </div>

          {testResult && (
            <div
              className={`mt-3 rounded-xl border p-3 text-sm ${
                testResult.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-900/20 dark:text-emerald-300'
                  : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-300'
              }`}
            >
              {testResult.ok ? (
                <p>
                  Test email sent to <span className="font-semibold">{testResult.to}</span>. Check
                  the inbox and spam folder.
                </p>
              ) : (
                <p>Test failed: {testResult.error}</p>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Campaign builder */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900 dark:text-white">New campaign</h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {preview ? `${preview.selected} eligible emails` : 'Preview recipients before sending'}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              State
            </label>
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
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              City (optional)
            </label>
            <Input
              list="mail-sender-cities"
              placeholder="e.g. Pune"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
            <datalist id="mail-sender-cities">
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
              max={2000}
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value || '0', 10))}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            Subject — use {'{name}'}, {'{business}'}, {'{city}'}
          </label>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
            Message — use {'{name}'}, {'{business}'}, {'{city}'}, {'{state}'}, {'{email}'}
          </label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={6}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition-colors placeholder-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            An opt-out line is added automatically. Set MAIL_UNSUBSCRIBE_URL for a one-click
            unsubscribe link.
          </p>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Delay between emails (seconds)
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
              max={500}
              value={dailyCap}
              onChange={(e) => setDailyCap(parseInt(e.target.value || '50', 10))}
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={handlePreview} loading={previewLoading}>
            <RefreshCw className="w-4 h-4" /> Preview recipients
          </Button>
          <Button onClick={handleStart} loading={starting} disabled={!configured || !!activeJob}>
            <Send className="w-4 h-4" /> Start campaign
          </Button>
          {!configured && <span className="text-xs text-slate-500">Configure SMTP to send.</span>}
          {activeJob && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              A campaign is already running — stop it to start another.
            </span>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              <span className="font-semibold">{preview.selected}</span> emails selected
              {preview.matched !== preview.selected && (
                <span className="text-slate-500"> (of {preview.matched} eligible before the limit)</span>
              )}
            </p>
            {preview.sample?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {preview.sample.map((r: any) => (
                  <span
                    key={r.email}
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {r.business_name || 'Unknown'} • {r.email}
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
                {job.sent} sent • {job.failed} failed • {job.total} total • delay{' '}
                {job.delay_seconds}s • cap {job.daily_cap}/day
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
                <Button variant="outline" size="sm" onClick={handleResume} disabled={!configured}>
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
                    <TableHeadCell>Business</TableHeadCell>
                    <TableHeadCell>Email</TableHeadCell>
                    <TableHeadCell>Status</TableHeadCell>
                    <TableHeadCell>Error</TableHeadCell>
                  </tr>
                </thead>
                <tbody>
                  {detail.messages.slice(0, 50).map((m: any) => (
                    <tr key={m.id}>
                      <TableBodyCell>{m.business_name || '—'}</TableBodyCell>
                      <TableBodyCell>{m.email}</TableBodyCell>
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
                <p className="mt-2 text-xs text-slate-500">
                  Showing first {detail.messages.length} of {detail.total}.
                </p>
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
              icon={Inbox}
              title="No mail campaigns yet"
              subtitle="Configure SMTP, preview your recipients, and send your first campaign."
            />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <TableHeadCell>Started</TableHeadCell>
                <TableHeadCell>Subject</TableHeadCell>
                <TableHeadCell>Status</TableHeadCell>
                <TableHeadCell>Progress</TableHeadCell>
                <TableHeadCell>Sent</TableHeadCell>
                <TableHeadCell>Failed</TableHeadCell>
                <TableHeadCell>{''}</TableHeadCell>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j: any) => (
                <tr
                  key={j.id}
                  className={j.id === selectedId ? 'bg-brand-50/40 dark:bg-brand-900/10' : ''}
                >
                  <TableBodyCell>{new Date(j.created_at).toLocaleString()}</TableBodyCell>
                  <TableBodyCell>{j.subject}</TableBodyCell>
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

      {/* Opt-outs */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <ShieldOff className="w-4 h-4 text-slate-500" />
          <h3 className="font-semibold text-slate-900 dark:text-white">Opt-out list</h3>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Addresses here are skipped by every campaign. Add anyone who asks you to stop.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Email
            </label>
            <Input
              placeholder="name@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Reason (optional)
            </label>
            <Input
              placeholder="asked to stop"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
            />
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
                  <TableHeadCell>Email</TableHeadCell>
                  <TableHeadCell>Reason</TableHeadCell>
                  <TableHeadCell>Added</TableHeadCell>
                  <TableHeadCell>{''}</TableHeadCell>
                </tr>
              </thead>
              <tbody>
                {blacklist.map((b: any) => (
                  <tr key={b.email}>
                    <TableBodyCell>{b.email}</TableBodyCell>
                    <TableBodyCell>{b.reason || '—'}</TableBodyCell>
                    <TableBodyCell>{new Date(b.created_at).toLocaleDateString()}</TableBodyCell>
                    <TableBodyCell>
                      <Button variant="ghost" size="sm" onClick={() => handleRemoveBlacklist(b.email)}>
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
