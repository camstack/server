/**
 * TagInput — the tags of one record (D1054), typed freely with autocomplete of
 * the tags already in use. Each suggestion and each chip carries the "style"
 * affordance that opens {@link TagStyleDialog}; there is no separate tags page.
 *
 * Controlled: `value` is the record's tags, `onChange` reports the next list
 * (normalised: trimmed, deduplicated case-insensitively). The record's own Save
 * persists it; only the style is written from here, because a style belongs to
 * the tag, not to the record.
 */
import { sameTag, TAG_NAME_MAX_LENGTH, TAGS_PER_RECORD_MAX } from '@dominevo/types'
import { Palette, Plus } from 'lucide-react'
import { type JSX, type KeyboardEvent, useId, useMemo, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { IconButton } from '../../primitives/icon-button'
import { Input } from '../../primitives/input'
import { TagChip } from './tag-chip'
import { addTag, suggestTags } from './tag-model'
import { TagStyleDialog } from './tag-style-dialog'
import { useTagRegistry } from './use-tag-registry'

export interface TagInputProps {
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  /** Accessible name of the text box ("Tags"). */
  readonly label?: string
  readonly disabled?: boolean
  readonly className?: string
}

interface SuggestionRow {
  readonly name: string
  /** `true` for the "add what I typed" row. */
  readonly isNew: boolean
}

export function TagInput({
  value,
  onChange,
  label,
  disabled = false,
  className,
}: TagInputProps): JSX.Element {
  const uiText = useUiText()
  const registry = useTagRegistry()
  const listId = useId()
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [styling, setStyling] = useState<string | null>(null)
  const canStyle = registry.presence === 'present'
  const full = value.length >= TAGS_PER_RECORD_MAX

  const rows: readonly SuggestionRow[] = useMemo(() => {
    const known = (registry.entries ?? []).map((e) => e.name)
    const suggestions = suggestTags(draft, known, value).map((name) => ({
      name,
      isNew: false,
    }))
    const typed = draft.trim()
    const typedIsKnown =
      typed.length === 0 ||
      known.some((k) => sameTag(k, typed)) ||
      value.some((v) => sameTag(v, typed))
    return typedIsKnown ? suggestions : [{ name: typed, isNew: true }, ...suggestions]
  }, [registry.entries, draft, value])

  const add = (name: string): void => {
    onChange(addTag(value, name))
    setDraft('')
    setActive(0)
  }
  const removeAt = (name: string): void => {
    onChange(value.filter((v) => v !== name))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      const row = open ? rows[active] : undefined
      const pick = row?.name ?? draft.trim()
      if (pick.length > 0) {
        e.preventDefault()
        add(pick)
      }
      return
    }
    if (e.key === 'Backspace' && draft.length === 0 && value.length > 0) {
      const last = value[value.length - 1]
      if (last !== undefined) removeAt(last)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Escape') setOpen(false)
  }

  const showList = open && !disabled && !full && rows.length > 0

  return (
    <div className={cn('relative space-y-1', className)}>
      {value.length > 0 && (
        <div className={cn('flex flex-wrap items-center gap-1', disabled && 'opacity-60')}>
          {value.map((tag) => (
            <TagChip
              key={tag}
              name={tag}
              entries={registry.entries}
              onStyle={canStyle && !disabled ? () => setStyling(tag) : undefined}
              onRemove={disabled ? undefined : () => removeAt(tag)}
            />
          ))}
        </div>
      )}
      {!full && (
        <Input
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label ?? uiText('uiLibrary.tags.label', 'Tags')}
          value={draft}
          maxLength={TAG_NAME_MAX_LENGTH}
          disabled={disabled}
          placeholder={
            value.length === 0 ? uiText('uiLibrary.tags.placeholder', 'Add a tag') : undefined
          }
          onChange={(e) => {
            setDraft(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-md"
        >
          {rows.map((row, index) => (
            <li
              key={`${row.isNew ? 'new' : 'known'}:${row.name}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                'flex items-center gap-2 px-2 py-1',
                index === active && 'bg-surface-hover',
              )}
              // Keep the input focused: a mousedown would blur it and close the list first.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
            >
              <button // ui-check-ok: a listbox option row (role=option holds it), not a push button
                type="button"
                onClick={() => add(row.name)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
              >
                {row.isNew && <Plus className="h-3 w-3 flex-shrink-0 text-foreground-subtle" />}
                {row.isNew && (
                  <span className="text-foreground-muted">
                    {uiText('uiLibrary.tags.create', 'Add')}
                  </span>
                )}
                <TagChip name={row.name} entries={registry.entries} />
              </button>
              {canStyle && (
                <IconButton
                  variant="ghost"
                  icon={Palette}
                  className="h-6 w-6"
                  onClick={() => setStyling(row.name)}
                  aria-label={uiText('uiLibrary.tags.styleNamed', 'Colour and icon of {{name}}', {
                    name: row.name,
                  })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <TagStyleDialog
        name={styling}
        entries={registry.entries}
        onClose={() => setStyling(null)}
        onSave={registry.setStyle}
      />
    </div>
  )
}
