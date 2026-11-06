/* ------------------------------------------------------------------ */
/* SMS Sender — bulk SMS through Fast2SMS or Twilio, with delays,      */
/* a daily cap and an opt-out list.                                    */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  FlaskConical,
  Inbox,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  Settings,
  ShieldOff,
  Smartphone,
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

const PROVIDER_LABEL: Record<string, string> = {
  fast2sms: 'Fast2SMS (India)',
  twilio: 'Twilio (global)',
};

function badgeLabel(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '—';
}

function segments(text: string) {
  const length = String(text || '').length;
  return { length, count: Math.max(1, Math.ceil(length / 160)) };
}

export function SmsSenderPage() {
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
    'Hi {name}, this is regarding {business}. We help local businesses get more customers online. Reply STOP to opt out.'
  );
  const [delaySeconds, setDelaySeconds] = useState(15);
  const [dailyCap, setDailyCap] = useState(100);
  const [limit, setLimit] = useState(50);
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [provider, setProvider] = useState<'fast2sms' | 'twilio' | 'textbelt'>('fast2sms');
  const [countryCode, setCountryCode] = useState('91');
  const [apiKey, setApiKey] = useState('');
  const [senderId, setSenderId] = useState('');
  const [route, setRoute] = useState('q');
  const [templateId, setTemplateId] = useState('');
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [fromNumber, setFromNumber] = useState('');

  const [newPhone, setNewPhone] = useState('');
  const [newReason, setNewReason] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.getSmsStatus());
    } catch {
      /* backend not reachable yet */
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await api.listSmsJobs();
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
      setBlacklist(await api.getSmsBlacklist());
    } catch {
      /* ignore */
    }
  }, []);

  const loadDetail = useCallback(async (jobId: string) => {
    try {
      setDetail(await api.getSmsJob(jobId, 1, 100));
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
    const prov = status.provider;
    setProvider(prov === 'twilio' ? 'twilio' : prov === 'textbelt' ? 'textbelt' : 'fast2sms');
    setCountryCode(status.countryCode || '91');
    setSenderId(status.senderId || '');
    setRoute(status.route || 'q');
    setTemplateId(status.templateId || '');
    setAccountSid(status.accountSid || '');
    setFromNumber(status.from || '');
    setApiKey('');
    setAuthToken('');
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

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await api.saveSmsConfig({
        provider,
        countryCode,
        apiKey,
        senderId,
        route,
        templateId,
        accountSid,
        authToken,
        from: fromNumber,
      });
      setStatus(res);
      setApiKey('');
      setAuthToken('');
      setSettingsLoaded(false);
      add({
        type: 'success',
        title: 'SMS settings saved',
        message: 'Now use “Send test SMS” to confirm the provider login.',
      });
    } catch (err: any) {
      add({ type: 'error', title: 'Could not save', message: err.message });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleClearSettings = async () => {
    if (
      !window.confirm(
        'Remove the saved SMS settings? You will need to re-enter the API key. Environment variables are not affected.'
      )
    ) {
      return;
    }
    try {
      const res = await api.clearSmsConfig();
      setStatus(res);
      setApiKey('');
      setAuthToken('');
      setSettingsLoaded(false);
      add({ type: 'success', title: 'Saved settings removed' });
    } catch (err: any) {
      add({ type: 'error', title: 'Could not remove', message: err.message });
    }
  };

  const handleTest = async () => {
    if (!configured) {
      add({ type: 'warning', title: 'Not configured', message: 'Save your SMS provider settings first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testSms(testTo.trim(), testMessage.trim() || undefined);
      setTestResult({ ok: true, ...res });
      add({ type: 'success', title: 'Test SMS sent', message: `Check ${res.to}.` });
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
      setPreview(await api.previewSmsRecipients({ state: formState, city: city.trim(), limit }));
    } catch (err: any) {
      add({ type: 'error', title: 'Preview failed', message: err.message });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleStart = async () => {
    if (!configured) {
      add({ type: 'warning', title: 'Not configured', message: 'Save your SMS provider settings first.' });
      return;
    }
    if (!template.trim()) {
      add({ type: 'warning', title: 'Empty message', message: 'Write a message template first.' });
      return;
    }
    setStarting(true);
    try {
      const res = await api.startSmsCampaign({
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
        message: `${res.total} SMS queued at ~${delaySeconds}s apart.`,
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
    if (!window.confirm('Stop this campaign? Pending SMS will not be sent.')) return;
    try {
      await api.stopSmsJob(activeJob.id);
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
      await api.resumeSmsJob(activeJob.id);
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
      await api.addSmsBlacklist(newPhone.trim(), newReason.trim());
      setNewPhone('');
      setNewReason('');
      add({ type: 'success', title: 'Number opted out' });
      await loadBlacklist();
    } catch (err: any) {
      add({ type: 'error', title: 'Could not add', message: err.message });
    }
  };

  const handleRemoveBlacklist = async (phone: string) => {
    try {
      await api.removeSmsBlacklist(phone);
      await loadBlacklist();
    } catch (err: any) {
      add({ type: 'error', title: 'Could not remove', message: err.message });
    }
  };

  const job = detail?.job || (selectedId ? jobs.find((j) => j.id === selectedId) : null) || null;
  const counts = detail?.counts || {};
  const doneCount = (counts.sent || 0) + (counts.failed || 0);
  const pct = job?.total ? Math.min(100, Math.round((doneCount / job.total) * 100)) : 0;
  const messageStats = segments(template);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="SMS Sender"
        subtitle="Text the phone numbers found by Find Leads through Fast2SMS or Twilio, with delays, a daily cap and an opt-out list."
      />

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">Cold SMS rules</p>
          <p className="mt-1">
            Only text businesses you have a legitimate reason to contact. In India, promotional SMS
            requires DLT registration (entity, sender ID and template) — without it, carriers block
            the message. Include an opt-out line, keep volume low, and never text purchased lists.
          </p>
        </div>
      </div>

      {/* Provider setup + test */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center">
              <Smartphone className="w-5 h-5 text-brand-600 dark:text-brand-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-semibold text-slate-900 dark:text-white">SMS provider</p>
                <Badge variant={configured ? 'done' : 'failed'}>
                  {configured ? 'Configured' : 'Not configured'}
                </Badge>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {configured
                  ? `${status?.providerLabel} • ${status?.todaySent ?? 0} sent today${
                      status?.source === 'env' ? ' (environment variables)' : ''
                    }`
                  : 'Enter your provider credentials below, save, then send a test SMS.'}
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
            {showSettings ? 'Hide settings' : configured ? 'Edit settings' : 'Configure SMS'}
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
                  Provider
                </label>
                <Select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as 'fast2sms' | 'twilio' | 'textbelt')}
                >
                  <option value="fast2sms">Fast2SMS (India)</option>
                  <option value="twilio">Twilio (global)</option>
                  <option value="textbelt">TextBelt (free tier)</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Default country code
                </label>
                <Input
                  placeholder="91"
                  value={countryCode}
                  onChange={(e) => setCountryCode(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Used for 10-digit numbers. India = 91.
                </p>
              </div>

              {provider === 'fast2sms' ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      API key
                    </label>
                    <Input
                      type="password"
                      placeholder={status?.hasApiKey ? 'Saved — leave blank to keep' : 'Fast2SMS API key'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Sender ID (optional)
                    </label>
                    <Input
                      placeholder="TXTIND"
                      value={senderId}
                      onChange={(e) => setSenderId(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Route
                    </label>
                    <Select value={route} onChange={(e) => setRoute(e.target.value)}>
                      <option value="q">Quick SMS (q)</option>
                      <option value="v3">Bulk v3</option>
                      <option value="dlt">DLT template</option>
                    </Select>
                  </div>
                  {route === 'dlt' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        DLT template ID
                      </label>
                      <Input
                        placeholder="1207xxxxxxxxxxxx"
                        value={templateId}
                        onChange={(e) => setTemplateId(e.target.value)}
                      />
                    </div>
                  )}
                </>
              ) : provider === 'twilio' ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Account SID
                    </label>
                    <Input
                      placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={accountSid}
                      onChange={(e) => setAccountSid(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Auth token
                    </label>
                    <Input
                      type="password"
                      placeholder={status?.hasAuthToken ? 'Saved — leave blank to keep' : 'Twilio auth token'}
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      From number
                    </label>
                    <Input
                      placeholder="+14155550123"
                      value={fromNumber}
                      onChange={(e) => setFromNumber(e.target.value)}
                    />
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      Must be E.164 with a leading +.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      API key
                    </label>
                    <Input
                      type="password"
                      placeholder={status?.hasApiKey ? 'Saved — leave blank to keep' : 'TextBelt API key (free tier)'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={handleSaveSettings} loading={savingSettings}>
                <Settings className="w-4 h-4" /> Save settings
              </Button>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Saved locally to <code>backend/data/sms-config.json</code>; keys are never returned to
                the browser.
              </span>
            </div>

            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Fast2SMS needs an API key from your dashboard. Twilio needs an Account SID, Auth Token
              and a sending number. TextBelt has a free daily tier — get a key at textbelt.com. You
              can also set these values in <code>backend/.env</code>.
            </p>
          </div>
        )}

        <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <h3 className="font-semibold text-slate-900 dark:text-white">Test SMS</h3>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Send one real SMS to yourself. Test messages do not count toward the daily cap or
            campaign history.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                Send to
              </label>
              <Input
                placeholder="+91 98765 43210"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                Message (optional)
              </label>
              <Input
                placeholder="Test from Lead Finder"
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3">
            <Button onClick={handleTest} loading={testing} disabled={!configured}>
              <Send className="w-4 h-4" /> Send test SMS
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
                  Test SMS sent to <span className="font-semibold">{testResult.to}</span>.
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
            {preview ? `${preview.selected} eligible numbers` : 'Preview recipients before sending'}
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
              list="sms-sender-cities"
              placeholder="e.g. Pune"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
            <datalist id="sms-sender-cities">
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
            Message — use {'{name}'}, {'{business}'}, {'{city}'}, {'{state}'}
          </label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={5}
            className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition-colors placeholder-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            {messageStats.length} characters • ~{messageStats.count} SMS segment
            {messageStats.count === 1 ? '' : 's'} per recipient (160 chars per segment). Keep it
            short and include an opt-out line.
          </p>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Delay between SMS (seconds)
            </label>
            <Input
              type="number"
              min={3}
              max={600}
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(parseInt(e.target.value || '15', 10))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Daily cap (all campaigns)
            </label>
            <Input
              type="number"
              min={1}
              max={2000}
              value={dailyCap}
              onChange={(e) => setDailyCap(parseInt(e.target.value || '100', 10))}
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
          {!configured && <span className="text-xs text-slate-500">Configure SMS to send.</span>}
          {activeJob && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              A campaign is already running — stop it to start another.
            </span>
          )}
        </div>

        {preview && (
          <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              <span className="font-semibold">{preview.selected}</span> numbers selected
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
                    {r.name || 'Unknown'} • {r.phone}
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
                      <TableBodyCell>{m.phone}</TableBodyCell>
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
              icon={MessageSquare}
              title="No SMS campaigns yet"
              subtitle="Configure a provider, preview your recipients, and send your first campaign."
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
                <tr
                  key={j.id}
                  className={j.id === selectedId ? 'bg-brand-50/40 dark:bg-brand-900/10' : ''}
                >
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

      {/* Opt-outs */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <ShieldOff className="w-4 h-4 text-slate-500" />
          <h3 className="font-semibold text-slate-900 dark:text-white">Opt-out list</h3>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Numbers here are skipped by every campaign. Add anyone who replies STOP.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Phone
            </label>
            <Input
              placeholder="+91 98765 43210"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Reason (optional)
            </label>
            <Input
              placeholder="replied STOP"
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
                  <TableHeadCell>Phone</TableHeadCell>
                  <TableHeadCell>Reason</TableHeadCell>
                  <TableHeadCell>Added</TableHeadCell>
                  <TableHeadCell>{''}</TableHeadCell>
                </tr>
              </thead>
              <tbody>
                {blacklist.map((b: any) => (
                  <tr key={b.phone}>
                    <TableBodyCell>{b.phone}</TableBodyCell>
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
