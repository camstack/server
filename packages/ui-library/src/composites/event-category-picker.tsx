/**
 * EventCategoryPicker — choose which event categories a view follows.
 *
 * Offers the catalogued categories (`EVENT_CATEGORY_CATALOG`) grouped as the
 * catalogue groups them, each with its label and its raw id, plus a custom
 * pattern row for what the catalogue does not name: an exact id or
 * `prefix.*`. The selection is a plain list of those entries; matching an
 * event against it is `matchesCategorySelection`.
 */
import { Plus, X } from 'lucide-react'
import { useMemo, useState, type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'
import {
  eventCategoryGroups,
  parseCategoryPattern,
  type EventCategoryOption,
} from '../lib/event-category-selection'
import { Badge } from '../primitives/badge'
import { Button } from '../primitives/button'
import { Checkbox } from '../primitives/checkbox'
import { IconButton } from '../primitives/icon-button'
import { Input } from '../primitives/input'

export interface EventCategoryPickerProps {
  /** The selection: exact category ids and `prefix.*` patterns. */
  readonly value: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  /** What "Defaults" restores. */
  readonly defaults: readonly string[]
  /** Admin language (`<html lang>`); labels follow it. Defaults to the document's. */
  readonly lang?: string
}

function documentLang(): string {
  return typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en'
}

function without(list: readonly string[], entry: string): readonly string[] {
  return list.filter((c) => c !== entry)
}

export function EventCategoryPicker({
  value,
  onChange,
  defaults,
  lang,
}: EventCategoryPickerProps): JSX.Element {
  const t = useUiText()
  const [search, setSearch] = useState('')
  const [custom, setCustom] = useState('')
  const language = lang ?? documentLang()
  const groups = useMemo(() => eventCategoryGroups(language), [language])
  const offered = useMemo(
    () => new Set(groups.flatMap((g) => g.entries.map((e) => e.id as string))),
    [groups],
  )
  const selected = useMemo(() => new Set(value), [value])
  const customEntries = value.filter((c) => !offered.has(c))
  const needle = search.trim().toLowerCase()
  const visible = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          entries: g.entries.filter(
            (e) => needle === '' || e.label.toLowerCase().includes(needle) || e.id.includes(needle),
          ),
        }))
        .filter((g) => g.entries.length > 0),
    [groups, needle],
  )
  const parsedCustom = parseCategoryPattern(custom)

  const toggle = (id: string): void => {
    onChange(selected.has(id) ? without(value, id) : [...value, id])
  }
  const addCustom = (): void => {
    if (parsedCustom === null || selected.has(parsedCustom)) return
    onChange([...value, parsedCustom])
    setCustom('')
  }

  return (
    <div className="flex min-h-0 flex-col" data-testid="event-category-picker">
      <div className="border-b border-border-subtle p-2">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('uiLibrary.eventPicker.search', 'Find a category…')}
          aria-label={t('uiLibrary.eventPicker.search', 'Find a category…')}
        />
      </div>
      <div className="flex flex-wrap gap-1 border-b border-border-subtle p-2">
        <Button size="sm" variant="outline" onClick={() => onChange([...offered])}>
          {t('uiLibrary.eventPicker.all', 'All')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onChange([])}>
          {t('uiLibrary.eventPicker.none', 'None')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onChange(defaults)}>
          {t('uiLibrary.eventPicker.defaults', 'Defaults')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <p className="px-3 py-3 text-center text-xs text-foreground-subtle">
            {t('uiLibrary.eventPicker.noMatches', 'No matching category')}
          </p>
        )}
        {visible.map((g) => (
          <section key={g.group} aria-label={t(`uiLibrary.eventPicker.group.${g.group}`, g.group)}>
            <h4 className="sticky top-0 bg-surface px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
              {t(`uiLibrary.eventPicker.group.${g.group}`, g.group)}
            </h4>
            {g.entries.map((e) => (
              <CategoryRow
                key={e.id}
                option={e}
                checked={selected.has(e.id)}
                onToggle={() => toggle(e.id)}
              />
            ))}
          </section>
        ))}
      </div>
      <div className="space-y-2 border-t border-border-subtle p-2">
        <p className="text-xs font-medium text-foreground-muted">
          {t('uiLibrary.eventPicker.customTitle', 'Custom pattern')}
        </p>
        <div className="flex items-center gap-1">
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addCustom()
            }}
            state={custom !== '' && parsedCustom === null ? 'error' : 'default'}
            placeholder={t('uiLibrary.eventPicker.customPlaceholder', 'exact.id or prefix.*')}
            aria-label={t('uiLibrary.eventPicker.customTitle', 'Custom pattern')}
          />
          <IconButton
            icon={Plus}
            size="sm"
            variant="outline"
            aria-label={t('uiLibrary.eventPicker.customAdd', 'Add pattern')}
            disabled={parsedCustom === null || selected.has(parsedCustom)}
            onClick={addCustom}
          />
        </div>
        {customEntries.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {customEntries.map((c) => (
              <li key={c} className="flex items-center gap-0.5">
                <Badge variant="default" className="font-mono">
                  {c}
                </Badge>
                <IconButton
                  icon={X}
                  size="sm"
                  variant="ghost"
                  aria-label={t('uiLibrary.eventPicker.customRemove', 'Remove {{pattern}}', {
                    pattern: c,
                  })}
                  onClick={() => onChange(without(value, c))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function CategoryRow({
  option,
  checked,
  onToggle,
}: {
  readonly option: EventCategoryOption
  readonly checked: boolean
  readonly onToggle: () => void
}): JSX.Element {
  const t = useUiText()
  return (
    <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-surface-hover">
      <Checkbox checked={checked} onChange={onToggle} />
      <span className="shrink-0 text-foreground">{option.label}</span>
      {option.noise && (
        <Badge variant="warning" size="sm">
          {t('uiLibrary.eventPicker.noise', 'Frequent')}
        </Badge>
      )}
      <span className="min-w-0 truncate font-mono text-foreground-subtle">{option.id}</span>
    </label>
  )
}
