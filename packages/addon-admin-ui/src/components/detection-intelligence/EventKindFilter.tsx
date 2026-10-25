/**
 * EventKindFilter — hierarchical (macro → sub) event-kind selector for the
 * Events grid. Selecting a MACRO selects the macro + all its subs; subs can be
 * toggled individually. Search matches the TRANSLATED label at any level. The
 * emitted `selected` set is EXPANDED (macro ⇒ macro + subs) so the caller can
 * filter track `className`s directly.
 *
 * The tree is DERIVED, never declared: the caller passes the groups built by
 * `event-kind-vocabulary` from `pipelineAnalytics.listEventKindsBatch`, so the
 * menu offers exactly what the cameras in scope can emit. This component used
 * to build the tree itself from the static `EVENT_TAXONOMY` dictionary, which
 * offered every camera all 53 kinds in the system — `package-delivered` on
 * cameras with no package zone, `doorbell` on cameras with no doorbell.
 *
 * Timeline surfaces use the macro subset only; this events-page filter
 * exposes the full tree (design §9).
 */
import { useMemo, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Search, Tag as TagIcon } from 'lucide-react'
import type { EventKindDescriptor } from '@camstack/types'
import { resolveEventKindIcon, eventKindLabel, useClassPainter } from '@camstack/ui-library'
import type { KindGroup } from './event-kind-vocabulary.js'

export interface EventKindFilterProps {
  /** Macro → sub tree for the cameras in scope, derived from the API. */
  readonly groups: readonly KindGroup[]
  /** Expanded set of selected kinds (macro ⇒ macro + subs). */
  readonly selected: ReadonlySet<string>
  readonly onChange: (next: Set<string>) => void
  /** True while the vocabulary query is in flight (menu shows a hint). */
  readonly loading?: boolean
}

export function EventKindFilter({
  groups,
  selected,
  onChange,
  loading = false,
}: EventKindFilterProps): JSX.Element {
  const { t } = useTranslation()
  const paint = useClassPainter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const q = query.trim().toLowerCase()

  const matches = (e: EventKindDescriptor): boolean =>
    q.length === 0 || eventKindLabel(e, t).toLowerCase().includes(q)

  const visibleGroups = useMemo(
    () =>
      groups
        .map((g) => ({
          macro: g.macro,
          subs: g.subs.filter((s) => matches(s) || matches(g.macro)),
        }))
        .filter((g) => matches(g.macro) || g.subs.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, q],
  )

  const toggleExpand = (kind: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  const toggleMacro = (group: KindGroup): void => {
    const next = new Set(selected)
    const allOn = selected.has(group.macro.kind) && group.subs.every((s) => selected.has(s.kind))
    const kinds = [group.macro.kind, ...group.subs.map((s) => s.kind)]
    if (allOn) for (const k of kinds) next.delete(k)
    else for (const k of kinds) next.add(k)
    onChange(next)
  }

  const toggleSub = (kind: string): void => {
    const next = new Set(selected)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    onChange(next)
  }

  const clearAll = (): void => onChange(new Set())

  const count = selected.size

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
          count > 0
            ? 'bg-primary/12 text-primary font-medium'
            : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
        }`}
      >
        <TagIcon className="h-3.5 w-3.5" />
        {count > 0
          ? t('detectionIntelligence.eventKindFilter.kinds', 'Kinds ({{value1}})', {
              value1: String(count),
            })
          : t('detectionIntelligence.eventKindFilter.kinds2', 'Kinds')}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 max-h-80 w-64 overflow-auto rounded-md border border-border bg-surface p-2 shadow-lg">
          <div className="mb-2 flex items-center gap-1 rounded border border-border px-1.5">
            <Search className="h-3.5 w-3.5 text-foreground-subtle" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('detectionIntelligence.eventKindFilter.searchKinds', 'Search kinds…')}
              className="w-full bg-transparent py-1 text-xs outline-none"
            />
            {count > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="text-[10px] text-foreground-subtle hover:text-foreground"
              >
                {t('detectionIntelligence.eventKindFilter.clear', 'Clear')}
              </button>
            )}
          </div>

          {visibleGroups.length === 0 && (
            <div className="px-1 py-2 text-[11px] text-foreground-subtle">
              {loading
                ? t('detectionIntelligence.eventKindFilter.loadingKinds', 'Loading kinds…')
                : q.length > 0
                  ? t(
                      'detectionIntelligence.eventKindFilter.noKindMatchesThatSearch',
                      'No kind matches that search.',
                    )
                  : t(
                      'detectionIntelligence.eventKindFilter.theseCamerasAdvertiseNoEvent',
                      'These cameras advertise no event kinds.',
                    )}
            </div>
          )}

          {visibleGroups.map((g) => {
            const Icon = resolveEventKindIcon(g.macro.iconId)
            const isExpanded = expanded.has(g.macro.kind) || q.length > 0
            const macroChecked = selected.has(g.macro.kind)
            return (
              <div key={g.macro.kind} className="mb-0.5">
                <div className="flex items-center gap-1">
                  {g.subs.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => toggleExpand(g.macro.kind)}
                      className="text-foreground-subtle hover:text-foreground"
                      aria-label={t('detectionIntelligence.eventKindFilter.expand', 'Expand')}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                  ) : (
                    <span className="w-3" />
                  )}
                  <label className="flex flex-1 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-surface-hover">
                    <input
                      type="checkbox"
                      checked={macroChecked}
                      onChange={() => toggleMacro(g)}
                      className="accent-primary"
                    />
                    <Icon
                      className="h-3.5 w-3.5"
                      // ui-check-ok: event-kind icon paints a palette data colour
                      style={{ color: paint(g.macro.kind) }}
                    />
                    <span className="font-medium">{eventKindLabel(g.macro, t)}</span>
                  </label>
                </div>
                {isExpanded &&
                  g.subs.map((s) => {
                    const SubIcon = resolveEventKindIcon(s.iconId)
                    return (
                      <label
                        key={s.kind}
                        className="ml-5 flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-surface-hover"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(s.kind)}
                          onChange={() => toggleSub(s.kind)}
                          className="accent-primary"
                        />
                        <SubIcon
                          className="h-3.5 w-3.5"
                          // ui-check-ok: event-kind icon paints a palette data colour
                          style={{ color: paint(s.kind) }}
                        />
                        <span>{eventKindLabel(s, t)}</span>
                      </label>
                    )
                  })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
