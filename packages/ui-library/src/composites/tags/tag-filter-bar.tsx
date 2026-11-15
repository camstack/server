/**
 * TagFilterBar — the search box, the Tags filter menu and the flat | by-tag
 * view switch of one section (D1054). The search matches row text AND tag
 * names (the caller filters with `matchesTagSearch`). The Tags menu filters by
 * any of the chosen tags and is where a tag is styled, renamed or removed —
 * each one server call; remove asks first. Controlled: the state lives in
 * `useTagFilter`.
 */
import { Palette, Pencil, Search, Trash2, X } from 'lucide-react'
import { type JSX, useRef, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useSearchFieldHotkey } from '../../hotkeys/use-search-field-hotkey'
import { Button } from '../../primitives/button'
import { IconButton } from '../../primitives/icon-button'
import { useConfirmIfAvailable, usePromptIfAvailable } from '../confirm-dialog'
import { MultiSelectDropdown } from '../device-list/multi-select'
import { ViewSwitch } from '../view-switch'
import { TagChip } from './tag-chip'
import type { TagCount, TagViewMode } from './tag-model'
import { TagStyleDialog } from './tag-style-dialog'
import type { TagRegistry } from './use-tag-registry'

export interface TagFilterMenuProps {
  /** The tags the section's rows carry. */
  readonly tags: readonly TagCount[]
  readonly selected: readonly string[]
  readonly onSelectedChange: (next: readonly string[]) => void
  readonly mode: TagViewMode
  readonly onModeChange: (mode: TagViewMode) => void
  readonly registry: TagRegistry
}

/**
 * The Tags filter menu (with style / rename / remove per tag) and the
 * flat | by-tag switch — the part of {@link TagFilterBar} a list with its own
 * search box (the device list) places in its own toolbar. Renders nothing
 * while no row carries a tag.
 */
export function TagFilterMenu({
  tags,
  selected,
  onSelectedChange,
  mode,
  onModeChange,
  registry,
}: TagFilterMenuProps): JSX.Element | null {
  const uiText = useUiText()
  // Rename and remove ask first; where no dialog host is mounted they are not offered.
  const confirm = useConfirmIfAvailable()
  const prompt = usePromptIfAvailable()
  const [styling, setStyling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canManage = registry.presence === 'present'
  const canAsk = confirm !== undefined && prompt !== undefined

  const rename = async (name: string): Promise<void> => {
    if (prompt === undefined) return
    const to = await prompt({
      title: uiText('uiLibrary.tags.renameTitle', 'Rename tag'),
      message: uiText(
        'uiLibrary.tags.renameMessage',
        'Every element tagged {{name}} gets the new name.',
        { name },
      ),
      label: uiText('uiLibrary.tags.newName', 'New name'),
      defaultValue: name,
      confirmLabel: uiText('uiLibrary.tags.rename', 'Rename'),
    })
    if (to === null || to.trim().length === 0 || to.trim() === name) return
    setError(null)
    try {
      await registry.rename(name, to.trim())
      onSelectedChange(selected.filter((s) => s !== name))
    } catch (e: unknown) {
      setError(errorText(e))
    }
  }

  const remove = async (name: string): Promise<void> => {
    if (confirm === undefined) return
    const accepted = await confirm({
      title: uiText('uiLibrary.tags.removeTitle', 'Remove tag?'),
      message: uiText(
        'uiLibrary.tags.removeMessage',
        '{{name}} is removed from every element that carries it, and its colour and icon are forgotten.',
        { name },
      ),
      confirmLabel: uiText('uiLibrary.tags.remove', 'Remove'),
      variant: 'danger',
    })
    if (!accepted) return
    setError(null)
    try {
      await registry.remove(name)
      onSelectedChange(selected.filter((s) => s !== name))
    } catch (e: unknown) {
      setError(errorText(e))
    }
  }

  if (tags.length === 0) return null
  return (
    <>
      <MultiSelectDropdown
        label={uiText('uiLibrary.tags.filterLabel', 'Tags')}
        options={tags.map((tag) => ({ id: tag.name, label: tag.name }))}
        selected={selected}
        onChange={onSelectedChange}
        renderOption={(option) => (
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <TagChip name={option.id} entries={registry.entries} />
            <span className="tabular-nums text-foreground-subtle">
              {tags.find((t) => t.name === option.id)?.count}
            </span>
          </span>
        )}
        optionActions={
          canManage
            ? (option) => (
                <>
                  <IconButton
                    variant="ghost"
                    icon={Palette}
                    className="h-6 w-6"
                    aria-label={uiText('uiLibrary.tags.styleNamed', 'Colour and icon of {{name}}', {
                      name: option.id,
                    })}
                    onClick={() => setStyling(option.id)}
                  />
                  {canAsk && (
                    <>
                      <IconButton
                        variant="ghost"
                        icon={Pencil}
                        className="h-6 w-6"
                        aria-label={uiText('uiLibrary.tags.renameNamed', 'Rename {{name}}', {
                          name: option.id,
                        })}
                        onClick={() => void rename(option.id)}
                      />
                      <IconButton
                        variant="ghost"
                        icon={Trash2}
                        className="h-6 w-6 hover:text-danger"
                        aria-label={uiText(
                          'uiLibrary.tags.removeEverywhere',
                          'Remove {{name}} everywhere',
                          {
                            name: option.id,
                          },
                        )}
                        onClick={() => void remove(option.id)}
                      />
                    </>
                  )}
                </>
              )
            : undefined
        }
      />
      <ViewSwitch<TagViewMode>
        ariaLabel={uiText('uiLibrary.tags.viewLabel', 'Show')}
        value={mode}
        onChange={onModeChange}
        options={[
          { id: 'flat', label: uiText('uiLibrary.tags.viewFlat', 'List') },
          {
            id: 'grouped',
            label: uiText('uiLibrary.tags.viewGrouped', 'By tag'),
          },
        ]}
        testId="tag-view"
      />
      {error !== null && <span className="text-xs text-danger">{error}</span>}
      <TagStyleDialog
        name={styling}
        entries={registry.entries}
        onClose={() => setStyling(null)}
        onSave={registry.setStyle}
      />
    </>
  )
}

export interface TagFilterBarProps extends TagFilterMenuProps {
  readonly search: string
  readonly onSearch: (search: string) => void
  /** Accessible name of the search box — say which list. */
  readonly searchLabel: string
  readonly searchPlaceholder?: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TagFilterBar({
  search,
  onSearch,
  searchLabel,
  searchPlaceholder,
  ...menu
}: TagFilterBarProps): JSX.Element {
  const uiText = useUiText()
  const searchRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchRef)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-[12rem] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={
            searchPlaceholder ?? uiText('uiLibrary.tags.searchPlaceholder', 'Search names and tags')
          }
          aria-label={searchLabel}
          className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground"
        />
      </label>
      <TagFilterMenu {...menu} />
      {(search.length > 0 || menu.selected.length > 0) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearch('')
            menu.onSelectedChange([])
          }}
        >
          <X className="h-3 w-3" />
          {uiText('uiLibrary.tags.clear', 'Clear')}
        </Button>
      )}
    </div>
  )
}
