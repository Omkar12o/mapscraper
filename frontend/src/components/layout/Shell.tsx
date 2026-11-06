/* ------------------------------------------------------------------ */
/* Shell — app layout: sidebar + topbar + page area + toasts          */
/* ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ToastProvider } from '../ui';

export type PageKey = 'dashboard' | 'finder' | 'mailfinder' | 'mailsender' | 'whatsapp' | 'smssender' | 'database' | 'saved' | 'history' | 'sources' | 'settings';

interface ShellProps {
  children: React.ReactNode;
  page: PageKey;
  onPageChange: (key: PageKey) => void;
}

export function Shell({ children, page, onPageChange }: ShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  // Persist dark mode preference
  useEffect(() => {
    const saved = localStorage.getItem('leadfinder-dark');
    if (saved !== null) {
      setDarkMode(saved === 'true');
    }
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  // Shared sidebar width — used by both sidebar and main margin-left
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '72px' : '320px');
  }, [collapsed]);

  return (
    <ToastProvider>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 relative">
        {/* Top bar — full width, sits above everything */}
        <Topbar
          onToggleSidebar={() => setCollapsed((c) => !c)}
          onDarkModeToggle={setDarkMode}
          darkMode={darkMode}
          onNewSearch={() => onPageChange('finder')}
          onGlobalSearch={(q) => {
            // Global search: navigate to finder and seed niche if it's a known quick pick
            onPageChange('finder');
            window.dispatchEvent(new CustomEvent('leadfinder:global-search', { detail: q }));
          }}
          userName="Admin"
        />

        {/* Below the top bar: [sidebar][main] flex row */}
        <div className="flex relative min-h-[calc(100vh-64px)]">
          <Sidebar
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            activeKey={page}
            onSelect={(k) => onPageChange(k as PageKey)}
            userName="Admin"
          />
          <main
            className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden"
            style={{ marginLeft: 'var(--sidebar-w)', paddingTop: '88px', paddingRight: '24px', paddingBottom: '24px', paddingLeft: '24px' }}
          >
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
