/* ------------------------------------------------------------------ */
/* Saved lists page                                                   */
/* ------------------------------------------------------------------ */

import { useCallback, useState } from 'react';
import { ArrowLeft, Download, Search, Trash2, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, SectionHeader, Table, TableBodyCell, TableHeadCell } from '../components/ui';

type SavedList = {
  id: string;
  name: string;
  lead_count: number;
  created_at: string;
};

const DEFAULT_LISTS: SavedList[] = [
  { id: '1', name: 'Hot Leads', lead_count: 0, created_at: new Date().toISOString() },
  { id: '2', name: 'Follow Up', lead_count: 0, created_at: new Date().toISOString() },
  { id: '3', name: 'Cold Leads', lead_count: 0, created_at: new Date().toISOString() },
];

export function SavedListsPage() {
  const [lists, setLists] = useState<SavedList[]>(DEFAULT_LISTS);
  const [query, setQuery] = useState('');

  const filtered = lists.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));

  const handleCreate = () => {
    const name = window.prompt('List name:');
    if (!name) return;
    setLists((prev) => [
      ...prev,
      { id: String(Date.now()), name, lead_count: 0, created_at: new Date().toISOString() },
    ]);
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this list?')) return;
    setLists((prev) => prev.filter((l) => l.id !== id));
  };

  const handleOpen = (list: SavedList) => {
    alert(`Opening list "${list.name}" (${list.lead_count} leads). Lead selection from the database will be added here.`);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <SectionHeader title="Saved lists" subtitle="Save and organize your best leads into lists." />
        </div>
        <Button onClick={handleCreate} variant="primary">
          <Users className="w-4 h-4" /> New list
        </Button>
      </div>

      <div className="mb-6">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lists…"
            className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2.5 text-sm outline-none transition-colors
              focus:ring-2 focus:ring-brand-500 focus:border-brand-500
              dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card padding="lg">
          <EmptyState
            icon={Users}
            title="No lists found"
            subtitle="Create a new list to start saving leads."
            action={
              <Button variant="primary" onClick={handleCreate}>
                <Users className="w-4 h-4" /> New list
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">List</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Leads</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Created</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((list) => (
                  <tr key={list.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleOpen(list)}
                        className="font-medium text-slate-800 dark:text-slate-200 hover:text-brand-600 dark:hover:text-brand-400 hover:underline"
                      >
                        {list.name}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="done" size="sm">{list.lead_count}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {new Date(list.created_at).toLocaleDateString(undefined, {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        onClick={() => handleOpen(list)}
                        variant="outline"
                        size="sm"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" /> Open
                      </Button>
                      <Button
                        onClick={() => handleDelete(list.id)}
                        variant="danger"
                        size="sm"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
