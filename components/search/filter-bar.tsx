'use client';
// "Understood as": the filters the search actually ran, as chips (PLAN.md § 3.9). Tap a chip to
// edit it (a popover on desktop, a bottom sheet on a phone), × to remove it, "+ Filter" to add one.
// Warnings for what couldn't be searched are amber chips; ignored puffery is a quiet note.
import Link from 'next/link';
import {
  Ban,
  Briefcase,
  Building2,
  ChevronDown,
  CircleCheck,
  Clock,
  GraduationCap,
  Info,
  MapPin,
  Plus,
  Sparkle,
  Star,
  TrendingUp,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useToast } from '@/components/ui/toast';
import { useSaveBrief } from '@/lib/client/hooks/mutations';
import { useSavedBriefs } from '@/lib/client/hooks/queries';
import { useIsDesktop } from '@/lib/client/hooks/use-media-query';
import {
  addedChipKeys,
  applySuggestion,
  filterChips,
  filtersKey,
  removeChip,
  removedChips,
  removeUnsupported,
  SENIORITY_LABELS,
  STATE_NAMES,
  type ChipKind,
  type EditorTarget,
  type FilterChip,
} from '@/lib/shared/chips';
import { hasSubstantiveFilter, type Filters, type Suggestion, type Unsupported } from '@/lib/shared/filters';
import { editorTitle, FilterEditor, type EditorParts } from './filter-editors';

const ICONS: Record<ChipKind, LucideIcon> = {
  seniority: TrendingUp,
  role: Briefcase,
  skill: Sparkle,
  location: MapPin,
  years: Clock,
  experience: Building2,
  open_to_work: CircleCheck,
  education: GraduationCap,
  exclude: Ban,
};

type Editing = { anchor: HTMLElement } & ({ kind: 'filter'; target: EditorTarget } | { kind: 'unsupported'; index: number });

type Props = {
  brief: string;
  /** The filters the shown results were found with. */
  applied: Filters;
  /** Unapplied edits (free plan), or null. */
  draft: Filters | null;
  onChange: (next: Filters) => void;
  /** True when a change re-runs the search at once (paid, nothing staged). */
  immediate: boolean;
  busy: boolean;
};

export function FilterBar({ brief, applied, draft, onChange, immediate, busy }: Props) {
  const shown = draft ?? applied;
  const chips = filterChips(shown);
  const added = draft ? addedChipKeys(applied, draft) : new Set<string>();
  const removed = draft ? removedChips(applied, draft) : [];
  const [editing, setEditing] = useState<Editing | null>(null);
  const headingId = useId();

  const edit = (target: EditorTarget) => (e: { currentTarget: HTMLElement }) => setEditing({ kind: 'filter', target, anchor: e.currentTarget });
  const change = (next: Filters) => {
    setEditing(null);
    onChange(next);
  };

  return (
    <section aria-labelledby={headingId} aria-busy={busy} className={cn('transition-opacity', busy && 'pointer-events-none opacity-60')}>
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-center gap-2 text-xs font-semibold tracking-wider whitespace-nowrap text-stone-500 uppercase">
          Understood as
          {draft && <span className="bg-ink rounded-full px-2 py-0.5 text-[10px] tracking-normal text-white normal-case">Not applied</span>}
        </h2>
        {hasSubstantiveFilter(applied) && <SaveSearchButton brief={brief} filters={applied} />}
      </div>

      <ul className="mt-2 flex flex-wrap gap-2">
        {chips.map((c) => (
          <Chip key={c.key} chip={c} state={added.has(c.key) ? 'added' : 'applied'} onEdit={edit(c.editor)} onRemove={() => change(removeChip(shown, c.key))} />
        ))}
        {(shown.unsupported ?? []).map((u, i) => (
          <UnsupportedChip
            key={`${u.text}-${i}`}
            item={u}
            onOpen={(e) => setEditing({ kind: 'unsupported', index: i, anchor: e.currentTarget })}
            onRemove={() => change(removeUnsupported(shown, i))}
          />
        ))}
        {removed.map((c) => (
          <li key={`removed-${c.key}`} className="flex h-9 items-center rounded-full border border-dashed border-stone-300 px-3 text-sm text-stone-400 line-through sm:h-8">
            <span className="sr-only">Removed, not applied yet: </span>
            {c.label}
          </li>
        ))}
        <li>
          <AddFilter onPick={(target, anchor) => setEditing({ kind: 'filter', target, anchor })} />
        </li>
      </ul>

      {(shown.ignored?.length ?? 0) > 0 && (
        <p className="mt-3 flex gap-1.5 text-[13px] text-stone-500">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Ignored as too subjective to filter on: {shown.ignored?.map((w) => `“${w}”`).join(', ')}
          </span>
        </p>
      )}

      {editing && (
        <Panel
          anchor={editing.anchor}
          onClose={() => setEditing(null)}
          {...(editing.kind === 'filter'
            ? {
                ...editorTitle(editing.target),
                render: (layout) => (
                  <FilterEditor
                    key={JSON.stringify(editing.target)}
                    target={editing.target}
                    filters={shown}
                    onApply={change}
                    onCancel={() => setEditing(null)}
                    applyLabel={immediate ? 'Apply' : 'Done'}
                    layout={layout}
                  />
                ),
              }
            : unsupportedPanel(shown, editing.index, change, immediate))}
        />
      )}
    </section>
  );
}

function Chip({ chip, state, onEdit, onRemove }: { chip: FilterChip; state: 'applied' | 'added'; onEdit: (e: { currentTarget: HTMLElement }) => void; onRemove: () => void }) {
  const Icon = ICONS[chip.kind];
  return (
    <li
      className={cn(
        'flex h-9 items-center rounded-full text-sm text-indigo-900 sm:h-8',
        state === 'added' ? 'border border-dashed border-indigo-400 bg-white' : 'bg-indigo-50 ring-1 ring-indigo-200 ring-inset',
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        aria-haspopup="dialog"
        aria-label={`${chip.label}${state === 'added' ? ' (not applied yet)' : ''}. Edit`}
        className="flex h-full items-center gap-1.5 rounded-l-full pr-0.5 pl-3 hover:bg-indigo-100/70 sm:pr-1"
      >
        <Icon aria-hidden className="size-3.5 text-indigo-600" />
        <span className="max-w-[16rem] truncate font-medium">{chip.label}</span>
        <ChevronDown aria-hidden className="hidden size-3.5 sm:block text-indigo-400" />
      </button>
      <button type="button" onClick={onRemove} aria-label={`Remove ${chip.label}`} className="grid h-full w-8 place-items-center rounded-r-full text-indigo-500 hover:bg-indigo-100 hover:text-indigo-900">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

function UnsupportedChip({ item, onOpen, onRemove }: { item: Unsupported; onOpen: (e: { currentTarget: HTMLElement }) => void; onRemove: () => void }) {
  return (
    <li className="flex h-9 items-center rounded-full bg-amber-50 text-sm text-amber-950 ring-1 ring-amber-300 ring-inset sm:h-8">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-label={`Can’t search for “${item.text}”. Show why`}
        className="flex h-full items-center gap-1.5 rounded-l-full pr-0.5 pl-3 hover:bg-amber-100 sm:pr-1"
      >
        <TriangleAlert aria-hidden className="size-3.5 text-amber-700" />
        <span className="max-w-[16rem] truncate font-medium">{item.text}</span>
        <ChevronDown aria-hidden className="hidden size-3.5 sm:block text-amber-600" />
      </button>
      <button type="button" onClick={onRemove} aria-label={`Remove “${item.text}” from the search`} className="grid h-full w-8 place-items-center rounded-r-full text-amber-700 hover:bg-amber-100 hover:text-amber-950">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

const suggestionLabel = (s: Suggestion) =>
  s.values.map((v) => (s.field === 'seniority' ? SENIORITY_LABELS[v as keyof typeof SENIORITY_LABELS] : s.field === 'states' ? STATE_NAMES[v as keyof typeof STATE_NAMES] : v)).join(', ');

function unsupportedPanel(filters: Filters, index: number, change: (f: Filters) => void, immediate: boolean): Pick<PanelProps, 'title' | 'render'> {
  const item = filters.unsupported?.[index];
  return {
    title: 'This part can’t be searched',
    render: (layout) =>
      item &&
      layout({
        body: (
          <div className="space-y-3">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950 ring-1 ring-amber-200 ring-inset">“{item.text}”</p>
            <p className="text-sm text-stone-700">{item.reason}</p>
            <p className="text-sm text-stone-500">
              While it’s part of the search, no one is shown, rather than people who don’t fit.
              {immediate ? '' : ' Removing it is applied together with your other changes.'}
            </p>
          </div>
        ),
        footer: (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => change(removeUnsupported(filters, index))}>
              Remove from search
            </Button>
            {item.suggestion && (
              <Button size="sm" onClick={() => change(applySuggestion(filters, index))}>
                Use {suggestionLabel(item.suggestion)} instead
              </Button>
            )}
          </div>
        ),
      }),
  };
}

type PanelProps = { anchor: HTMLElement; onClose: () => void; title: string; description?: string; render: (layout: (p: EditorParts) => ReactNode) => ReactNode };

/** A popover next to the chip on desktop; a bottom sheet on a phone. */
function Panel({ anchor, onClose, title, description, render }: PanelProps) {
  const desktop = useIsDesktop();
  // Radix measures this "virtual" anchor: the chip (or + Filter) that opened the panel.
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const titleId = useId();
  const returnFocus = (e: Event) => {
    e.preventDefault();
    if (anchor.isConnected) anchor.focus();
  };

  if (desktop) {
    return (
      <Popover open onOpenChange={(o) => !o && onClose()}>
        <PopoverAnchor virtualRef={anchorRef} />
        {/* Capped at the room Radix measures below (or above) the chip, so Apply never ends up off screen. */}
        <PopoverContent aria-labelledby={titleId} onCloseAutoFocus={returnFocus} className="flex max-h-(--radix-popover-content-available-height) flex-col">
          {render(({ body, footer }) => (
            <>
              <div className="shrink-0 border-b border-stone-100 px-4 pt-3.5 pb-3">
                <p id={titleId} className="font-semibold">
                  {title}
                </p>
                {description && <p className="mt-0.5 text-[13px] text-stone-500">{description}</p>}
              </div>
              <div className="max-h-[min(22rem,55vh)] min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">{body}</div>
              <div className="shrink-0 border-t border-stone-100 px-4 py-3">{footer}</div>
            </>
          ))}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {render(({ body, footer }) => (
        <DialogContent title={title} description={description} footer={footer} onCloseAutoFocus={returnFocus}>
          {body}
        </DialogContent>
      ))}
    </Dialog>
  );
}

const ADD: { label: string; target: EditorTarget; icon: LucideIcon }[] = [
  { label: 'Role', target: { field: 'roles' }, icon: Briefcase },
  { label: 'Level', target: { field: 'seniority' }, icon: TrendingUp },
  { label: 'Skills', target: { field: 'skills_all' }, icon: Sparkle },
  { label: 'Location', target: { field: 'location' }, icon: MapPin },
  { label: 'Years of experience', target: { field: 'years' }, icon: Clock },
  { label: 'Company history', target: { field: 'experience', index: null }, icon: Building2 },
  { label: 'Open to work', target: { field: 'open_to_work' }, icon: CircleCheck },
  { label: 'School', target: { field: 'schools' }, icon: GraduationCap },
  { label: 'Degree', target: { field: 'degrees' }, icon: GraduationCap },
  { label: 'Field of study', target: { field: 'fields' }, icon: GraduationCap },
  { label: 'Graduation year', target: { field: 'graduated' }, icon: GraduationCap },
];

function AddFilter({ onPick }: { onPick: (target: EditorTarget, anchor: HTMLElement) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu modal={false}>
      <MenuTrigger
        ref={trigger}
        className="flex h-9 items-center gap-1 rounded-full border border-dashed border-stone-400 px-3 text-sm font-medium text-stone-700 hover:border-stone-500 hover:bg-white hover:text-ink sm:h-8 data-[state=open]:bg-white"
      >
        <Plus aria-hidden className="size-3.5" /> Filter
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[60vh] overflow-y-auto">
        {ADD.map(({ label, target, icon: Icon }) => (
          <MenuItem
            key={label}
            onSelect={() => {
              // After the menu has closed and handed focus back, so the editor can take it.
              setTimeout(() => trigger.current && onPick(target, trigger.current), 0);
            }}
          >
            <Icon /> {label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function SaveSearchButton({ brief, filters }: { brief: string; filters: Filters }) {
  const saved = useSavedBriefs();
  const save = useSaveBrief();
  const toast = useToast();
  const key = useMemo(() => filtersKey(filters), [filters]);
  const isSaved = saved.data?.some((s) => s.brief === brief && filtersKey(s.filters) === key) ?? false;

  if (isSaved) {
    return (
      <Button asChild variant="accent" size="sm">
        <Link href="/saved" aria-label="Search saved. Open saved searches">
          <Star className="fill-indigo-600 text-indigo-600" /> Saved
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={save.isPending || saved.isPending}
      onClick={() =>
        save.mutate(
          { brief, filters },
          {
            onSuccess: () => toast({ title: 'Search saved', action: { label: 'View', href: '/saved' } }),
            onError: (err) => toast({ tone: 'error', title: err.message }),
          },
        )
      }
    >
      <Star /> Save search
    </Button>
  );
}
