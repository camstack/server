/**
 * The remote layout editor (D964): a grid of columns × rows with a live
 * preview, and for the selected button its role, face (icon or label),
 * position and size. Every edit goes through `layout-model`, so an overlap or a
 * button leaving the grid is refused with a sentence and the grid stays as it
 * was. Taps and steppers only — nothing needs a drag, so it works at 390 wide.
 */
import { customRole, type RemoteLayoutPayload } from '@camstack/types'
import {
  iconCategoryLabel,
  type IconCategoryId,
  isRemoteCustomKey,
  customKeyOfRole,
} from '@camstack/types'
import {
  Button,
  FormField,
  IconButton,
  IconPicker,
  type IconPickerLabels,
  Input,
  OptionSelect,
  type OptionSelectOption,
  Stepper,
} from '@camstack/ui-library'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Shapes, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  addButton,
  humanRole,
  isCustomRole,
  knownRolesOfGroup,
  type LayoutResult,
  removeButton,
  resizeButton,
  resizeGrid,
  ROLE_GROUP_ORDER,
  setButtonFace,
  shiftButton,
} from './layout-model'
import { RemoteGrid } from './RemoteGrid'

const CUSTOM_CHOICE = '__custom__'

export interface RemoteLayoutEditorProps {
  readonly value: RemoteLayoutPayload
  readonly onChange: (next: RemoteLayoutPayload) => void
}

export function RemoteLayoutEditor({ value, onChange }: RemoteLayoutEditorProps): ReactNode {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const selected = value.buttons.find((b) => b.id === selectedId) ?? null

  const apply = (result: LayoutResult, then?: (grid: RemoteLayoutPayload) => void): void => {
    if (result.status === 'ok') {
      setRefusal(null)
      onChange(result.grid)
      then?.(result.grid)
      return
    }
    setRefusal(t(`remote.layout.refusal.${result.reason}`))
  }

  const add = (): void =>
    apply(addButton(value, 'ok'), (grid) => setSelectedId(grid.buttons.at(-1)?.id ?? null))

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
          onSelect={setSelectedId}
          showEmptyCells
        />
        <Button variant="outline" size="sm" onClick={add} data-testid="remote-add-button">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('remote.layout.addButton')}
        </Button>
        {refusal !== null && (
          <p role="alert" className="text-xs text-warning" data-testid="remote-layout-refusal">
            {refusal}
          </p>
        )}
      </div>
      <div className="min-w-0">
        {selected === null ? (
          <p className="text-xs text-foreground-subtle">{t('remote.layout.selectHint')}</p>
        ) : (
          <ButtonInspector
            grid={value}
            buttonId={selected.id}
            apply={apply}
            onRemove={() => {
              onChange(removeButton(value, selected.id))
              setSelectedId(null)
              setRefusal(null)
            }}
          />
        )}
      </div>
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
