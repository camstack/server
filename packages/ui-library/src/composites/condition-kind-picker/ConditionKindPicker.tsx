import type {
  AutomationLeafCategory,
  AutomationLeafContext,
  AutomationLeafKind,
} from '@camstack/types'
import { Search } from 'lucide-react'
import { type JSX, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { Badge } from '../../primitives/badge'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../primitives/dialog'
import { Input } from '../../primitives/input'
import { CONDITION_KIND_ICONS } from './condition-kind-icons'
import {
  buildKindPicker,
  type KindDisabledReason,
  type KindPickerItem,
  type KindTexts,
} from './condition-kind-picker-model'
import { useRecentKinds } from './use-recent-kinds'

export interface ConditionKindPickerProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  /** Where the row is added: a trigger tree, or a step's guard (states only). */
  readonly context: AutomationLeafContext
  /** The row sits under a NOT: an instant cannot be negated. */
  readonly underNot: boolean
  /** Adding to a tree already at its row bound. False when changing a row's type. */
  readonly treeFull: boolean
  readonly suggested?: readonly AutomationLeafKind[]
  /** Kinds with no meaning in this place: left out entirely, not disabled. */
  readonly hidden?: readonly AutomationLeafKind[]
  /** Remembers the kinds picked here last time (per place). */
  readonly recentKey?: string
  readonly textsOf: (kind: AutomationLeafKind) => KindTexts
  readonly categoryLabelOf: (category: AutomationLeafCategory) => string
  readonly reasonOf: (reason: KindDisabledReason) => string
  /**
   * The kind of the row being changed: highlighted when the search is empty.
   * Absent (adding a row) = nothing is highlighted until the operator types.
   */
  readonly current?: AutomationLeafKind
  readonly onPick: (kind: AutomationLeafKind) => void
}

interface RowEntry {
  readonly id: string
  readonly item: KindPickerItem
}

interface SectionEntry {
  readonly id: string
  readonly testId: string
  readonly heading: string
  readonly count: number
  readonly rows: readonly RowEntry[]
}

function rowsOf(section: string, items: readonly KindPickerItem[]): readonly RowEntry[] {
  return items.map((item) => ({ id: `${section}:${item.kind}`, item }))
}

interface KindRowProps {
  readonly entry: RowEntry
  readonly active: boolean
  readonly reason: string | null
  readonly onPick: (kind: AutomationLeafKind) => void
}

function KindRow({ entry, active, reason, onPick }: KindRowProps): JSX.Element {
  const t = useUiText()
  const { item } = entry
  const Icon = CONDITION_KIND_ICONS[item.kind]
  const disabled = item.disabled !== null
  return (
    <button // ui-check-ok: a listbox option row (icon, texts, badge), not a push button
      type="button"
      role="option"
      id={entry.id}
      aria-selected={active}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => onPick(item.kind)}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        active ? 'bg-surface-hover' : 'hover:bg-surface-hover',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-foreground-muted" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{item.label}</span>
          <Badge variant={item.role === 'event' ? 'info' : 'neutral'}>
            {item.role === 'event'
              ? t('uiLibrary.conditionKindPicker.event', 'event')
              : t('uiLibrary.conditionKindPicker.state', 'state')}
          </Badge>
        </span>
        <span className="text-xs text-foreground-muted">{item.description}</span>
        <span className="text-xs text-foreground-subtle">
          {t('uiLibrary.conditionKindPicker.example', 'e.g. {{example}}', {
            example: item.example,
          })}
        </span>
        {reason !== null ? <span className="text-xs text-warning">{reason}</span> : null}
      </span>
    </button>
  )
}

function nextEnabled(rows: readonly RowEntry[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < rows.length; i += step) {
    if (rows[i]?.item.disabled === null) return i
  }
  return from
}

function PickerBody(props: ConditionKindPickerProps): JSX.Element {
  const t = useUiText()
  const recent = useRecentKinds(props.recentKey)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const view = useMemo(
    () =>
      buildKindPicker({
        context: props.context,
        query,
        textsOf: props.textsOf,
        categoryLabelOf: props.categoryLabelOf,
        underNot: props.underNot,
        treeFull: props.treeFull,
        recent: recent.kinds,
        suggested: props.suggested ?? [],
        ...(props.hidden === undefined ? {} : { hidden: props.hidden }),
      }),
    [props, query, recent.kinds],
  )

  const sections = useMemo((): readonly SectionEntry[] => {
    const out: SectionEntry[] = []
    if (view.suggested.length > 0) {
      out.push({
        id: 'suggested',
        testId: 'kind-section-suggested',
        heading: t('uiLibrary.conditionKindPicker.suggested', 'Suggested'),
        count: view.suggested.length,
        rows: rowsOf('suggested', view.suggested),
      })
    }
    if (view.recent.length > 0) {
      out.push({
        id: 'recent',
        testId: 'kind-section-recent',
        heading: t('uiLibrary.conditionKindPicker.recent', 'Recently used'),
        count: view.recent.length,
        rows: rowsOf('recent', view.recent),
      })
    }
    for (const group of view.groups) {
      out.push({
        id: group.category,
        testId: `kind-group-${group.category}`,
        heading: group.label,
        count: group.count,
        rows: rowsOf(group.category, group.items),
      })
    }
    return out
  }, [view, t])

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const best =
    view.firstEnabled === null
      ? null
      : (flat.find((r) => r.item.kind === view.firstEnabled && r.item.disabled === null) ?? null)
  // An empty search highlights the row being changed (or nothing when adding);
  // a typed search highlights its best enabled match.
  const current =
    props.current === undefined ? null : (flat.find((r) => r.item.kind === props.current) ?? null)
  const highlighted = flat.find((r) => r.id === activeId) ?? (query.trim() === '' ? current : best)

  const pick = (kind: AutomationLeafKind): void => {
    recent.push(kind)
    props.onPick(kind)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (highlighted !== null && highlighted.item.disabled === null) pick(highlighted.item.kind)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const from = highlighted === null ? -1 : flat.indexOf(highlighted)
    const index = nextEnabled(flat, from, event.key === 'ArrowDown' ? 1 : -1)
    const target = flat[index]
    if (target !== undefined && target.item.disabled === null) setActiveId(target.id)
  }

  useEffect(() => {
    if (highlighted === null) return
    document.getElementById(highlighted.id)?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <Input
          ref={inputRef}
          type="search"
          role="searchbox"
          value={query}
          leftSlot={<Search className="size-3.5 text-foreground-subtle" aria-hidden />}
          placeholder={t('uiLibrary.conditionKindPicker.search', 'Search conditions…')}
          aria-label={t('uiLibrary.conditionKindPicker.search', 'Search conditions…')}
          aria-controls="condition-kind-list"
          data-dialog-autofocus
          aria-activedescendant={highlighted?.id}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveId(null)
          }}
          onKeyDown={onKeyDown}
          className="mt-2"
        />
      </DialogHeader>
      <DialogBody>
        <div id="condition-kind-list" role="listbox" className="flex flex-col gap-3">
          {sections.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-foreground-muted">
              {t('uiLibrary.conditionKindPicker.empty', 'Nothing matches “{{query}}”', {
                query: query.trim(),
              })}
            </p>
          ) : (
            sections.map((section) => (
              <section
                key={section.id}
                data-testid={section.testId}
                className="flex flex-col gap-1"
              >
                <h3 className="px-2 text-xs font-semibold text-foreground-muted">
                  {section.heading}
                  <span className="ml-1.5 font-normal text-foreground-subtle">{section.count}</span>
                </h3>
                {section.rows.map((entry) => (
                  <KindRow
                    key={entry.id}
                    entry={entry}
                    active={highlighted?.id === entry.id}
                    reason={
                      entry.item.disabled === null ? null : props.reasonOf(entry.item.disabled)
                    }
                    onPick={pick}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </DialogBody>
    </>
  )
}

/**
 * The modal that adds (or retypes) a `when`-tree row: search, groups by
 * category, an icon / label / description / example per kind, and a kind this
 * place cannot take shown disabled with the reason. All filtering and ranking
 * is `buildKindPicker`; this renders it. The body mounts only while open, so a
 * reopen starts with an empty search and a focused field.
 */
export function ConditionKindPicker(props: ConditionKindPickerProps): JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent width="lg" scroll="body" placement="sheet-on-mobile">
        {props.open ? <PickerBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}
