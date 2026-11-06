/* ------------------------------------------------------------------ */
/* Sidebar — main navigation                                          */
/* ------------------------------------------------------------------ */

import { useState } from 'react';
import {
  LayoutDashboard,
  Search,
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
  Database,
  List,
  History,
  Settings as SettingsIcon,
  Bell as BellIcon,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

export type NavItem = {
  key: string;
  label: string;
  icon: React.ElementType;
  badge?: number | string;
};

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'finder', label: 'Find leads', icon: Search },
  { key: 'mailfinder', label: 'Mail Finder', icon: Mail },
  { key: 'mailsender', label: 'Mail Sender', icon: Send },
  { key: 'whatsapp', label: 'WhatsApp Sender', icon: MessageCircle },
  { key: 'smssender', label: 'SMS Sender', icon: MessageSquare },
  { key: 'database', label: 'Lead database', icon: Database },
  { key: 'saved', label: 'Saved lists', icon: List },
  { key: 'history', label: 'History', icon: History },
  { key: 'sources', label: 'Data sources', icon: SettingsIcon },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeKey: string;
  onSelect: (key: string) => void;
  userName?: string;
}

export function Sidebar({ collapsed, onToggleCollapse, activeKey, onSelect, userName }: SidebarProps) {
  return (
    <aside
      className="fixed top-16 bottom-0 left-0 z-30 border-r border-slate-200 bg-white transition-all duration-300 ease-in-out dark:border-slate-700 dark:bg-slate-900 px-3 w-[var(--sidebar-w)]"
      aria-label="Navigation"
    >
      <div className="flex h-full flex-col">
        {/* Header — only the collapse arrow (logo lives in the top bar) */}
        <div className="flex items-center justify-end px-2 py-3 border-b border-slate-100 dark:border-slate-700">
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition dark:hover:bg-slate-800 dark:hover:text-slate-300"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeKey === item.key;
            return (
              <button
                key={item.key}
                onClick={() => onSelect(item.key)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all
                  ${active
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
                  } ${collapsed ? 'justify-center px-2' : ''}`}
              >
                <Icon className={`w-5 h-5 ${active ? 'text-white' : ''}`} />
                {!collapsed && (
                  <>
                    {item.label}
                    {item.badge && (
                      <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[10px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </button>
            );
          })}
        </nav>

        {/* Bottom: profile block only (no duplicate Settings link) */}
        <div className="border-t border-slate-100 p-3 dark:border-slate-700 mt-auto">
          {userName && (
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-sm font-bold dark:bg-brand-900 dark:text-brand-300">
                {userName.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-slate-900 truncate dark:text-white">{userName}</p>
                <p className="text-[10px] text-slate-500 truncate dark:text-slate-400">admin@leadfinder.local</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

export function SidebarBackdrop({ onClick }: { onClick: () => void }) {
  return (
    <div
      className="fixed inset-0 z-20 bg-black/40 backdrop-blur-sm"
      onClick={onClick}
      aria-hidden="true"
    />
  );
}
