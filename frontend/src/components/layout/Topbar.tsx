/* ------------------------------------------------------------------ */
/* Topbar — global search, new search, dark mode, user                */
/* ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from 'react';
import {
  Search,
  Plus,
  Moon,
  Sun,
  Bell,
  Menu,
  User,
} from 'lucide-react';
import { Button } from '../ui';

interface TopbarProps {
  onToggleSidebar: () => void;
  onDarkModeToggle: (checked: boolean) => void;
  darkMode: boolean;
  onNewSearch: () => void;
  onGlobalSearch: (q: string) => void;
  userName?: string;
}

export function Topbar({
  onToggleSidebar,
  onDarkModeToggle,
  darkMode,
  onNewSearch,
  onGlobalSearch,
  userName,
}: TopbarProps) {
  const [q, setQ] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGlobalSearch(q.trim());
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur-md min-h-[64px] dark:border-slate-700 dark:bg-slate-900/80">
      <div className="flex items-center justify-between gap-4 px-6 py-3">
        {/* Left: menu toggle + brand */}
        <div className="flex items-center gap-4">
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition dark:hover:bg-slate-800 dark:hover:text-white"
            aria-label="Toggle navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Search className="w-5 h-5 text-brand-600" />
            <span className="font-bold text-xl tracking-tight text-slate-900 dark:text-white">Lead<span className="text-brand-600">Finder</span></span>
          </div>
        </div>

        {/* Center: global contact search */}
        <div className="hidden md:flex-1 max-w-md">
          <form onSubmit={handleSubmit} className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              ref={searchInputRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search all contacts…"
              className="w-full rounded-full border border-slate-300 pl-10 pr-4 py-2.5 text-sm outline-none transition-colors
                focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-400 hover:text-slate-700 transition"
              >
                <XIcon className="w-4 h-4" />
              </button>
            )}
          </form>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={onNewSearch}
            className="hidden md:flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600 text-white text-sm font-medium shadow-sm hover:bg-brand-700 transition"
          >
            <Plus className="w-4 h-4" /> New search
          </button>
          <button
            onClick={() => onDarkModeToggle(!darkMode)}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition dark:hover:bg-slate-800 dark:hover:text-white"
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkMode ? 'Dark mode' : 'Light mode'}
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          <button className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition dark:hover:bg-slate-800 dark:hover:text-white" aria-label="Notifications">
            <Bell className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 dark:bg-slate-800 dark:border-slate-700">
            <User className="w-4 h-4 text-slate-400" />
            <div className="hidden sm:flex flex-col items-end">
              <p className="text-xs font-medium text-slate-900 dark:text-white">{userName || 'Admin'}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">leadfinder.local</p>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile global search bar */}
      <div className="md:hidden border-b border-slate-200 dark:border-slate-700">
        <form onSubmit={handleSubmit} className="px-4 py-3 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search all contacts…"
            className="w-full rounded-full border border-slate-300 pl-10 pr-4 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
        </form>
      </div>
    </header>
  );
}

/* Small X icon (inline) */
function XIcon({ className }: { className?: string }) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>;
}
