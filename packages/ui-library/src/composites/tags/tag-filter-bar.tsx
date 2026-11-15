/**
 * The Tags filter menu of a section (D1054). The menu is the shared
 * multi-select (`MultiSelectDropdown`, as a `DataTableFilterBar` facet group in
 * `menu` display or in a list's own toolbar); this file adds what is specific to
 * tags: each option drawn as its chip with a count, and the per-tag actions —
 * colour and icon, rename, remove (each one server call; remove asks first) —
 * plus the flat | by-tag switch.
 */
import { Palette, Pencil, Trash2 } from 'lucide-react'
import { type JSX, type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { IconButton } from '../../primitives/icon-button'
import { useConfirmIfAvailable, usePromptIfAvailable } from '../confirm-dialog'
import { MultiSelectDropdown, type MultiSelectOption } from '../device-list/multi-select'
import { ViewSwitch } from '../view-switch'
import { TagChip } from './tag-chip'
import { type TagCount, type TagViewMode, followTagRename } from './tag-model'
import { TagStyleDialog } from './tag-style-dialog'
import type { TagRegistry } from './use-tag-registry'

export interface TagMenuActionsOptions {
  readonly registry: TagRegistry
  /** How many rows carry `name` (drawn beside its chip). */
  readonly countOf: (name: string) => number | undefined
  /** After a rename (`to`) or a remove (`to: null`) succeeded. */
  readonly onRenamed: (from: string, to: string | null) => void
}

export interface TagMenuActions {
  readonly renderOption: (option: MultiSelectOption) => ReactNode
  /** `undefined` when the `tags` cap is not known to be present (D315). */
  readonly optionActions: ((option: MultiSelectOption) => ReactNode) | undefined
  /** The style dialog and the last write's error — render once beside the menu. */
  readonly overlay: ReactNode
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The tag-specific parts of a Tags menu. Rename and remove ask first; where no
 * dialog host is mounted they are not offered.
 */
export function useTagMenuActions({
  registry,
  countOf,
  onRenamed,
}: TagMenuActionsOptions): TagMenuActions {
  const uiText = useUiText()
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
    const next = to?.trim() ?? ''
    if (next.length === 0 || next === name) return
    setError(null)
    try {
      await registry.rename(name, next)
      onRenamed(name, next)
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
      onRenamed(name, null)
    } catch (e: unknown) {
      setError(errorText(e))
    }
  }

  const renderOption = (option: MultiSelectOption): ReactNode => (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <TagChip name={option.id} entries={registry.entries} />
      <span className="tabular-nums text-foreground-subtle">{countOf(option.id)}</span>
    </span>
  )

  const optionActions = canManage
    ? (option: MultiSelectOption): ReactNode => (
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

  const overlay = (
    <>
      {error !== null && <span className="text-xs text-danger">{error}</span>}
      <TagStyleDialog
        name={styling}
        entries={registry.entries}
        onClose={() => setStyling(null)}
        onSave={registry.setStyle}
      />
    </>
  )

  return { renderOption, optionActions, overlay }
}

export interface TagViewSwitchProps {
  readonly mode: TagViewMode
  readonly onModeChange: (mode: TagViewMode) => void
}

/** The flat | by-tag switch of a tagged list. */
export function TagViewSwitch({ mode, onModeChange }: TagViewSwitchProps): JSX.Element {
  const uiText = useUiText()
  return (
    <ViewSwitch<TagViewMode>
      ariaLabel={uiText('uiLibrary.tags.viewLabel', 'Show')}
      value={mode}
      onChange={onModeChange}
      options={[
        { id: 'flat', label: uiText('uiLibrary.tags.viewFlat', 'List') },
        { id: 'grouped', label: uiText('uiLibrary.tags.viewGrouped', 'By tag') },
      ]}
      testId="tag-view"
    />
  )
}

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
 * The Tags menu and the view switch for a list with its own toolbar (the
 * device list), beside its other filter menus. Renders nothing while no row
 * carries a tag.
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
  const actions = useTagMenuActions({
    registry,
    countOf: (name) => tags.find((t) => t.name === name)?.count,
    onRenamed: (from, to) => onSelectedChange(followTagRename(selected, from, to)),
  })
  if (tags.length === 0) return null
  return (
    <>
      <MultiSelectDropdown
        label={uiText('uiLibrary.tags.filterLabel', 'Tags')}
        options={tags.map((tag) => ({ id: tag.name, label: tag.name }))}
        selected={selected}
        onChange={onSelectedChange}
        renderOption={actions.renderOption}
        optionActions={actions.optionActions}
      />
      <TagViewSwitch mode={mode} onModeChange={onModeChange} />
      {actions.overlay}
    </>
  )
}
