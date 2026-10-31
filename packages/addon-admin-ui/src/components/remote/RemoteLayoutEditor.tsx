/**
 * The remote layout editor (D964, D973): a grid of columns × rows with a live
 * preview, an "Add component" palette, and for the selected button or group its
 * role, face, look, position and size. Buttons and groups move by dragging
 * (the grid's cells light up and the landing footprint shows green or red) or
 * with the arrow keys of the focused item; the arrows and steppers of the
 * inspector stay, so nothing needs a pointer drag. Every edit goes through
 * `layout-model`, so an overlap or a button leaving the grid is refused with a
 * sentence and the grid stays as it was.
 */
import {
  customRole,
  REMOTE_BUTTON_SHAPES,
  REMOTE_BUTTON_TONES,
  type RemoteLayoutComponent,
  type RemoteLayoutPayload,
} from '@camstack/types'
import {
  iconCategoryLabel,
  type IconCategoryId,
  isRemoteCustomKey,
  customKeyOfRole,
} from '@camstack/types'
import {
  Button,
  Checkbox,
  FormField,
  IconButton,
  IconPicker,
  type IconPickerLabels,
  Input,
  OptionSelect,
  type OptionSelectOption,
  Select,
  Stepper,
} from '@camstack/ui-library'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Plus,
  Shapes,
  Trash2,
  Unlink,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_BRANDS, appIconKey, resolveAppBrand } from './app-brand-icons'
import { ComponentPalette } from './ComponentPalette'
import { placeComponent } from './layout-components'
import { arrowStep, type DragItem, nudgeItem } from './layout-drag'
import {
  addButton,
  deleteGroup,
  groupById,
  humanRole,
  isCustomRole,
  knownRolesOfGroup,
  type LayoutResult,
  membersOf,
  removeButton,
  resizeButton,
  resizeGrid,
  ROLE_GROUP_ORDER,
  setButtonFace,
  setButtonLook,
  setGroupTitle,
  setSeparatorOptions,
  shiftButton,
} from './layout-model'
import { RemoteGrid } from './RemoteGrid'
import { useGridDrag } from './useGridDrag'

const CUSTOM_CHOICE = '__custom__'

export interface RemoteLayoutEditorProps {
  readonly value: RemoteLayoutPayload
  readonly onChange: (next: RemoteLayoutPayload) => void
}

export function RemoteLayoutEditor({ value, onChange }: RemoteLayoutEditorProps): ReactNode {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<DragItem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const selectedId = selection?.kind === 'button' ? selection.id : null
  const selectedGroupId = selection?.kind === 'group' ? selection.id : null
  const selected = value.buttons.find((b) => b.id === selectedId) ?? null
  const selectedGroup = selectedGroupId === null ? undefined : groupById(value, selectedGroupId)

  const apply = (result: LayoutResult, then?: (grid: RemoteLayoutPayload) => void): void => {
    if (result.status === 'ok') {
      setRefusal(null)
      onChange(result.grid)
      then?.(result.grid)
      return
    }
    setRefusal(t(`remote.layout.refusal.${result.reason}`))
  }

  const dragState = useGridDrag(value, gridRef, (result) => apply(result))

  const add = (): void =>
    apply(addButton(value, 'ok'), (grid) => {
      const last = grid.buttons.at(-1)
      setSelection(last === undefined ? null : { kind: 'button', id: last.id })
    })

  const addComponent = (
    component: RemoteLayoutComponent,
    options: { fillWidth: boolean },
  ): void => {
    const placed = placeComponent(value, component, options)
    if (!placed.ok) {
      setRefusal(t(`remote.layout.refusal.${placed.reason}`))
      return
    }
    setRefusal(null)
    onChange(placed.layout)
    const first = placed.buttonIds[0]
    setSelection(
      placed.groupId !== null
        ? { kind: 'group', id: placed.groupId }
        : first === undefined
          ? null
          : { kind: 'button', id: first },
    )
  }

  const onItemKeyDown = (item: DragItem, event: KeyboardEvent<HTMLElement>): void => {
    const step = arrowStep(event.key)
    if (step === null) return
    event.preventDefault()
    apply(nudgeItem(value, item, step.dRow, step.dCol))
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <FormField label={t('remote.layout.columns')}>
            <Stepper
              value={value.columns}
              onDelta={(d) => apply(resizeGrid(value, value.columns + d, value.rows))}
            />
          </FormField>
          <FormField label={t('remote.layout.rows')}>
            <Stepper
              value={value.rows}
              onDelta={(d) => apply(resizeGrid(value, value.columns, value.rows + d))}
            />
          </FormField>
        </div>
        <RemoteGrid
          grid={value}
          label={t('remote.layout.previewLabel')}
          selectedId={selectedId}
          selectedGroupId={selectedGroupId}
          onSelect={(id) => {
            if (dragState.consumeDragClick()) return
            setSelection({ kind: 'button', id })
          }}
          onSelectGroup={(id) => {
            if (dragState.consumeDragClick()) return
            setSelection({ kind: 'group', id })
          }}
          showEmptyCells
          gridRef={gridRef}
          drag={dragState.drag}
          onItemPointerDown={dragState.onItemPointerDown}
          onItemKeyDown={onItemKeyDown}
        />
        <p className="text-xs text-foreground-subtle">{t('remote.layout.dragHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaletteOpen(true)}
            data-testid="remote-add-component"
          >
            <Shapes className="h-3.5 w-3.5" aria-hidden />
            {t('remote.layout.addComponent')}
          </Button>
          <Button variant="outline" size="sm" onClick={add} data-testid="remote-add-button">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('remote.layout.addButton')}
          </Button>
        </div>
        {refusal !== null && (
          <p role="alert" className="text-xs text-warning" data-testid="remote-layout-refusal">
            {refusal}
          </p>
        )}
      </div>
      <div className="min-w-0">
        {selected !== null ? (
          <ButtonInspector
            grid={value}
            buttonId={selected.id}
            apply={apply}
            onRemove={() => {
              onChange(removeButton(value, selected.id))
              setSelection(null)
              setRefusal(null)
            }}
          />
        ) : selectedGroup !== undefined ? (
          <GroupInspector
            grid={value}
            groupId={selectedGroup.id}
            apply={apply}
            onGone={() => setSelection(null)}
          />
        ) : (
          <p className="text-xs text-foreground-subtle">{t('remote.layout.selectHint')}</p>
        )}
      </div>
      <ComponentPalette
        open={paletteOpen}
        grid={value}
        onOpenChange={setPaletteOpen}
        onPick={addComponent}
      />
    </div>
  )
}

interface InspectorProps {
  readonly grid: RemoteLayoutPayload
  readonly buttonId: string
  readonly apply: (result: LayoutResult) => void
  readonly onRemove: () => void
}

function roleOptions(t: (key: string, fallback?: string) => string): readonly OptionSelectOption[] {
  const known = ROLE_GROUP_ORDER.flatMap((group) =>
    knownRolesOfGroup(group).map(
      (role): OptionSelectOption => ({
        value: role,
        label: t(`remote.role.${role}`, humanRole(role)),
        group: t(`remote.roleGroup.${group}`),
      }),
    ),
  )
  return [
    ...known,
    {
      value: CUSTOM_CHOICE,
      label: t('remote.layout.customRole'),
      group: t('remote.roleGroup.custom'),
    },
  ]
}

function ButtonInspector({ grid, buttonId, apply, onRemove }: InspectorProps): ReactNode {
  const { t } = useTranslation()
  const button = grid.buttons.find((b) => b.id === buttonId)
  const customKey = button === undefined ? null : customKeyOfRole(button.role)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  if (button === undefined) return null
  const custom = isCustomRole(button.role) || customDraft !== null
  const keyText = customDraft ?? customKey ?? ''
  const keyValid = isRemoteCustomKey(keyText)

  const labels: IconPickerLabels = {
    trigger: t('remote.layout.pickIcon'),
    panel: t('remote.layout.iconPanel'),
    searchPlaceholder: t('deviceDisplay.iconSearchPlaceholder'),
    clear: t('remote.layout.noIcon'),
    noMatches: t('deviceDisplay.iconNoMatches'),
  }
  const categoryLabel = (category: IconCategoryId): string =>
    t(`deviceDisplay.iconCategory.${category}`, {
      defaultValue: iconCategoryLabel(category),
    })

  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-surface p-3"
      data-testid="remote-inspector"
    >
      <OptionSelect
        mode="single"
        singleDisplay="field"
        label={t('remote.layout.role')}
        options={roleOptions((key, fallback) => t(key, fallback ?? key))}
        value={custom ? CUSTOM_CHOICE : button.role}
        onChange={(next) => {
          if (next === CUSTOM_CHOICE) {
            setCustomDraft(customKey ?? '')
            return
          }
          setCustomDraft(null)
          apply(setButtonFace(grid, button.id, { role: next }))
        }}
      />
      {custom && (
        <FormField
          label={t('remote.layout.customKey')}
          {...(keyText !== '' && !keyValid ? { error: t('remote.layout.customKeyInvalid') } : {})}
        >
          <Input
            value={keyText}
            placeholder="hdmi_1"
            onChange={(e) => {
              const next = e.target.value
              setCustomDraft(next)
              if (isRemoteCustomKey(next)) {
                apply(setButtonFace(grid, button.id, { role: customRole(next) }))
              }
            }}
          />
        </FormField>
      )}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-2">
        <FormField label={t('remote.layout.icon')}>
          <IconPicker
            value={button.icon ?? null}
            onPick={(key) => apply(setButtonFace(grid, button.id, { icon: key }))}
            fallbackGlyph={Shapes}
            categoryLabel={categoryLabel}
            labels={labels}
          />
        </FormField>
        <FormField label={t('remote.layout.label')}>
          <Input
            value={button.label ?? ''}
            maxLength={40}
            onChange={(e) => apply(setButtonFace(grid, button.id, { label: e.target.value }))}
          />
        </FormField>
      </div>
      <FormField label={t('remote.layout.appIcon')}>
        <Select
          value={resolveAppBrand(button.icon)?.key ?? ''}
          options={[
            { value: '', label: t('remote.layout.noApp') },
            ...APP_BRANDS.map((b) => ({ value: b.key, label: b.label })),
          ]}
          onChange={(e) => {
            const brandKey = e.target.value
            if (brandKey !== '') {
              apply(setButtonFace(grid, button.id, { icon: appIconKey(brandKey) }))
            } else if (resolveAppBrand(button.icon) !== undefined) {
              apply(setButtonFace(grid, button.id, { icon: null }))
            }
          }}
          data-testid="remote-app-icon"
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('remote.layout.shape')}>
          <Select
            value={button.shape ?? ''}
            options={[
              { value: '', label: t('remote.layout.lookDefault') },
              ...REMOTE_BUTTON_SHAPES.map((v) => ({
                value: v,
                label: t(`remote.layout.shapes.${v}`),
              })),
            ]}
            onChange={(e) => {
              const next = REMOTE_BUTTON_SHAPES.find((v) => v === e.target.value)
              apply(setButtonLook(grid, button.id, { shape: next ?? null }))
            }}
            data-testid="remote-shape"
          />
        </FormField>
        <FormField label={t('remote.layout.tone')}>
          <Select
            value={button.tone ?? ''}
            options={[
              { value: '', label: t('remote.layout.lookDefault') },
              ...REMOTE_BUTTON_TONES.map((v) => ({
                value: v,
                label: t(`remote.layout.tones.${v}`),
              })),
            ]}
            onChange={(e) => {
              const next = REMOTE_BUTTON_TONES.find((v) => v === e.target.value)
              apply(setButtonLook(grid, button.id, { tone: next ?? null }))
            }}
            data-testid="remote-tone"
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('remote.layout.move')}>
          <div className="flex items-center gap-1">
            <IconButton
              icon={ArrowLeft}
              size="sm"
              variant="secondary"
              aria-label={t('remote.layout.moveLeft')}
              onClick={() => apply(shiftButton(grid, button.id, 0, -1))}
            />
            <IconButton
              icon={ArrowUp}
              size="sm"
              variant="secondary"
              aria-label={t('remote.layout.moveUp')}
              onClick={() => apply(shiftButton(grid, button.id, -1, 0))}
            />
            <IconButton
              icon={ArrowDown}
              size="sm"
              variant="secondary"
              aria-label={t('remote.layout.moveDown')}
              onClick={() => apply(shiftButton(grid, button.id, 1, 0))}
            />
            <IconButton
              icon={ArrowRight}
              size="sm"
              variant="secondary"
              aria-label={t('remote.layout.moveRight')}
              onClick={() => apply(shiftButton(grid, button.id, 0, 1))}
            />
          </div>
        </FormField>
        <FormField label={t('remote.layout.position')}>
          <p className="text-xs text-foreground-muted" data-testid="remote-position">
            {t('remote.layout.positionValue', {
              row: button.row + 1,
              col: button.col + 1,
            })}
          </p>
        </FormField>
        <FormField label={t('remote.layout.height')}>
          <Stepper
            value={button.rowSpan}
            onDelta={(d) =>
              apply(resizeButton(grid, button.id, button.rowSpan + d, button.colSpan))
            }
          />
        </FormField>
        <FormField label={t('remote.layout.width')}>
          <Stepper
            value={button.colSpan}
            onDelta={(d) =>
              apply(resizeButton(grid, button.id, button.rowSpan, button.colSpan + d))
            }
          />
        </FormField>
      </div>
      <Button variant="danger" size="sm" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        {t('remote.layout.removeButton')}
      </Button>
    </div>
  )
}

interface GroupInspectorProps {
  readonly grid: RemoteLayoutPayload
  readonly groupId: string
  readonly apply: (result: LayoutResult) => void
  readonly onGone: () => void
}

/** The selected group: its title, how many keys it holds, and how to take it apart. */
function GroupInspector({ grid, groupId, apply, onGone }: GroupInspectorProps): ReactNode {
  const { t } = useTranslation()
  const group = groupById(grid, groupId)
  if (group === undefined) return null
  const members = membersOf(grid, groupId).length
  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-surface p-3"
      data-testid="remote-group-inspector"
    >
      <p className="text-xs text-foreground-muted">
        {t('remote.layout.groupSummary', {
          frame: t(`remote.layout.frames.${group.frame}`, group.frame),
          count: members,
          row: group.row + 1,
          col: group.col + 1,
        })}
      </p>
      <FormField label={t('remote.layout.groupTitle')}>
        <Input
          value={group.title ?? ''}
          maxLength={40}
          onChange={(e) => apply(setGroupTitle(grid, group.id, e.target.value))}
          data-testid="remote-group-title"
        />
      </FormField>
      {group.frame === 'divider' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('remote.layout.separatorSize')}>
            <Select
              value={group.size ?? 'compact'}
              options={[
                {
                  value: 'compact',
                  label: t('remote.layout.separatorSizeCompact'),
                },
                {
                  value: 'normal',
                  label: t('remote.layout.separatorSizeNormal'),
                },
              ]}
              onChange={(e) =>
                apply(
                  setSeparatorOptions(grid, group.id, {
                    size: e.target.value === 'normal' ? 'normal' : 'compact',
                  }),
                )
              }
              data-testid="remote-separator-size"
            />
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-xs text-foreground-muted">
            <Checkbox
              checked={group.hideTitle === true}
              onChange={(e) =>
                apply(
                  setSeparatorOptions(grid, group.id, {
                    hideTitle: e.target.checked,
                  }),
                )
              }
              data-testid="remote-separator-hide-title"
            />
            {t('remote.layout.separatorHideLabel')}
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="remote-group-ungroup"
          onClick={() => {
            apply(deleteGroup(grid, group.id, true))
            onGone()
          }}
        >
          <Unlink className="h-3.5 w-3.5" aria-hidden />
          {t('remote.layout.ungroup')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          data-testid="remote-group-delete"
          onClick={() => {
            apply(deleteGroup(grid, group.id, false))
            onGone()
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          {t('remote.layout.deleteGroup')}
        </Button>
      </div>
    </div>
  )
}
