/* ------------------------------------------------------------------ */
/* App — shell layout + routing                                       */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageKey } from './components/layout/Shell';
import { FindLeadsPage } from './pages/FindLeadsPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LeadDatabasePage } from './pages/LeadDatabasePage';
import { SavedListsPage } from './pages/SavedListsPage';
import { MailFinderPage } from './pages/MailFinderPage';

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Restore open run from URL
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const run = url.searchParams.get('run');
      if (run) setActiveRunId(run);
    } catch {
      /* ignore */
    }
  }, []);

  // Keep the open run in the URL so a reload restores it
  useEffect(() => {
    const url = new URL(window.location.href);
    if (activeRunId) url.searchParams.set('run', activeRunId);
    else url.searchParams.delete('run');
    window.history.replaceState({}, '', url);
  }, [activeRunId]);

  const openRun = (id: string) => {
    setActiveRunId(id);
    setPage('finder');
  };

  return (
    <Shell page={page} onPageChange={(k) => setPage(k as PageKey)}>
      {page === 'dashboard' && (
        <DashboardPage activeRunId={activeRunId} setActiveRunId={setActiveRunId} />
      )}
      {page === 'finder' && (
        <FindLeadsPage runId={activeRunId} onRunChange={setActiveRunId} />
      )}
      {page === 'mailfinder' && <MailFinderPage />}
      {page === 'database' && <LeadDatabasePage />}
      {page === 'saved' && <SavedListsPage />}
      {page === 'history' && (
        <HistoryPage
          onOpenRun={openRun}
          onBack={() => setPage('finder')}
          onOpenMailFinder={() => setPage('mailfinder')}
        />
      )}
      {page === 'settings' && <SettingsPage />}
      {page === 'sources' && <SettingsPage />}
    </Shell>
  );
}
