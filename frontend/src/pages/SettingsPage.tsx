/* ------------------------------------------------------------------ */
/* Settings / data sources page                                       */
/* ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, Card, SectionHeader } from '../components/ui';

export function SettingsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getSettings();
      setItems(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (provider: string, enabled?: boolean) => {
    const apiKey = edits[provider];
    try {
      await api.saveSetting({ provider, enabled, apiKey: apiKey ? apiKey : undefined });
      setEdits((e) => ({ ...e, [provider]: '' }));
      await load();
      setMsg((m) => ({ ...m, [provider]: 'Saved' }));
      setTimeout(() => setMsg((m) => ({ ...m, [provider]: '' })), 2000);
    } catch (err) {
      setMsg((m) => ({ ...m, [provider]: err instanceof Error ? err.message : 'Save failed' }));
    }
  };

  const handleTest = async (provider: string) => {
    setTesting(provider);
    setMsg((m) => ({ ...m, [provider]: '' }));
    try {
      const r = await api.testSetting(provider, edits[provider] || undefined);
      setMsg((m) => ({ ...m, [provider]: r.message || 'OK' }));
    } catch (err) {
      setMsg((m) => ({ ...m, [provider]: err instanceof Error ? err.message : 'Test failed' }));
    } finally {
      setTesting(null);
    }
  };

  const healthPill = (it: any) => {
    if (!it.enabled) return <Badge variant="stopped" size="sm">Disabled</Badge>;
    if (!it.hasKey && it.needsKey) return <Badge variant="stopped" size="sm">No key</Badge>;
    const used = it.limit > 0 ? Math.min(100, (it.used / it.limit) * 100) : 0;
    if (used >= 100) return <Badge variant="failed" size="sm">Quota used</Badge>;
    if (used >= 80) return <Badge variant="partly" size="sm">Slow</Badge>;
    return <Badge variant="done" size="sm">Healthy</Badge>;
  };

  if (loading)
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-brand-600" />
      </div>
    );

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <SectionHeader
        title="Data sources"
        subtitle="Paste API keys to enable extra providers. gosom runs first; others top up if the target is not reached. Keys are stored in the database and only the last 4 characters are shown."
      />

      <div className="space-y-4">
        {items.map((it) => {
          const used = it.limit > 0 ? Math.min(100, (it.used / it.limit) * 100) : 0;
          return (
            <Card key={it.provider} padding="md">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white">{it.name}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Free limit: {it.limit} {it.period} · Used: {it.used}
                    {it.needsKey ? '' : ' · no key required'}
                  </p>
                  {it.signup_url && (
                    <a
                      href={it.signup_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                    >
                      How to get this key &rarr; {it.signup_url}
                    </a>
                  )}
                </div>
                <div className="flex items-end gap-2">
                  {healthPill(it)}
                  <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none dark:text-slate-400">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={it.enabled}
                      onChange={(e) => handleSave(it.provider, e.target.checked)}
                      disabled={it.needsKey && !it.hasKey && !edits[it.provider]}
                    />
                    Enabled
                  </label>
                </div>
              </div>

              {it.needsKey && (
                <div className="flex flex-col sm:flex-row gap-2 mb-3">
                  <input
                    type="password"
                    placeholder={it.hasKey ? `Saved: ${it.keyTail}` : 'Paste API key'}
                    value={edits[it.provider] || ''}
                    onChange={(e) => setEdits((ed) => ({ ...ed, [it.provider]: e.target.value }))}
                    className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none
                      dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
                  />
                  <Button onClick={() => handleSave(it.provider)} size="sm">Save key</Button>
                  <Button
                    onClick={() => handleTest(it.provider)}
                    disabled={testing === it.provider}
                    variant="outline"
                    size="sm"
                  >
                    {testing === it.provider ? 'Testing…' : 'Test key'}
                  </Button>
                </div>
              )}

              {msg[it.provider] && (
                <p className="text-xs text-slate-600 mt-1 dark:text-slate-400">{msg[it.provider]}</p>
              )}

              <div className="mt-3 flex items-center gap-3">
                <div className="flex-1 bg-slate-200 rounded-full h-1.5 overflow-hidden dark:bg-slate-700">
                  <div
                    className="h-1.5 rounded-full bg-brand-600 transition-all"
                    style={{ width: `${used}%` }}
                  />
                </div>
                <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                  {it.used.toLocaleString()} / {it.limit.toLocaleString()}
                </span>
                <button
                  onClick={() => api.resetQuota(it.provider).then(load)}
                  className="text-[10px] text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 underline"
                >
                  Reset quota
                </button>
              </div>
            </Card>
          );
        })}

        {items.find((i) => i.provider === 'google_places') && (
          <Card padding="sm">
            <div className="bg-amber-50 border border-amber-200 p-4 text-amber-800 text-sm dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400">
              <b>Google Places API (New)</b> is OFF by default: its terms restrict storing data. Enable only if you accept those terms.
            </div>
          </Card>
        )}

        <Card padding="sm">
          <div className="bg-slate-50 border border-slate-200 p-4 text-slate-600 text-xs dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400">
            Geoapify results include OpenStreetMap data &mdash; attribution: &copy; OpenStreetMap contributors.
          </div>
        </Card>
      </div>
    </div>
  );
}
