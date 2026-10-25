/**
 * One Customize card for a declared keyed-array target. Native items stay
 * read-only. Assigned items are added, changed and removed one at a time.
 * An item this compiler did not write links to Advanced and is left in place.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  COMPOSITION_ITEM_ARRAY_PATH,
  type CompositionFieldsFeature,
  compositionItemFieldPath,
  compositionSourceKey,
  type CustomizeCatalogTarget,
  type DeviceInfo,
  mergeKeyedArrayItem,
  projectKeyedArrayAssignment,
  readKeyedArrayItems,
  type KeyedArrayItemView,
  type ScalarRead,
  type ScalarSourcePresence,
  withoutKeyedArrayItem,
} from '@camstack/types'
import { Badge, Button, ErrorBox } from '@camstack/ui-library'
import { Package, type LucideIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentAvailability,
  type AssignmentFacts,
  assignmentAvailability,
  offerFromCatalog,
} from '../assignment-availability'
import { FormulaEntryButton } from '../formula/FormulaEntryButton'
import { AssignmentRow } from '../assignments/AssignmentRow'
import { LiveValueText } from '../assignments/LiveValueText'
import type { CandidateDevice } from '../assignments/assignment-candidates'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { CustomizeCard } from '../CustomizeCard'
import { currentComposition } from '../customization-read'
import type { DefaultConsumable } from '../default-consumables'
import { featureOf, withFeature, withoutFeature } from '../customization-save'
import type { Known } from '../known'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { KeyedArrayItemDialog, type KeyedDialogSeed } from './KeyedArrayItemDialog'
import { NativeItemRows } from './NativeItemRows'

const ICONS: Readonly<Record<string, LucideIcon>> = { consumables: Package }

export interface KeyedCardTarget {
  readonly cap: string
  readonly target: CustomizeCatalogTarget
}

export function keyedArrayCardTargets(): readonly KeyedCardTarget[] {
  return Object.entries(CAP_CUSTOMIZE_CATALOG).flatMap(([cap, entry]) =>
    entry.targets
      .filter((target) => target.cardinality === 'keyedArray')
      .map((target) => ({ cap, target })),
  )
}

export interface KeyedArrayCardProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly availability: AssignmentAvailability
  readonly cap: string
  readonly target: CustomizeCatalogTarget
  readonly defaults: Known<readonly DefaultConsumable[]>
}

export function KeyedArrayCard(props: KeyedArrayCardProps): ReactNode {
  const { t, i18n } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const [dialog, setDialog] = useState<'add' | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = currentComposition(props.handle.state)
  const storedFeature = featureOf(current, props.cap)
  const stored = storedRead(props.handle, storedFeature)
  const read =
    stored.kind === 'known' && stored.value !== null
      ? readKeyedArrayItems(stored.value, props.cap, props.target.id)
      : null
  const devices = useCandidateDevices(read !== null)
  const presence = sourcePresence(read, devices)
  const projection = projectKeyedArrayAssignment({
    cap: props.cap,
    targetId: props.target.id,
    device: props.handle.target,
    stored,
    sourcePresence: presence,
    sourceUnknownReason: devices.kind === 'unknown' ? devices.reason : null,
  })
  if (!visible(props, storedFeature)) return null
  const answered = props.handle.state.kind === 'none' || props.handle.state.kind === 'present'
  const canAdd = props.availability.kind === 'present' && answered
  const apply = props.target.apply === 'replace' ? 'replace' : 'add'
  const title = t(`customize.keyed.title.${props.cap}`)
  const badgeText = badgeLabel(t, projection.text, projection.assignedCount)
  const save = async (next: Parameters<CustomizationHandle['save']>[0]): Promise<void> => {
    const outcome = await props.handle.save(next)
    setError(outcome.kind === 'refused' ? outcome.reason : null)
  }
  const removeItem = async (item: KeyedArrayItemView): Promise<void> => {
    if (current === null || storedFeature === null) return
    const nextFeature = withoutKeyedArrayItem(storedFeature, item.key)
    const next =
      nextFeature === null
        ? withoutFeature(current, props.cap)
        : withFeature(current, props.handle.target, nextFeature)
    if (
      await confirmRemove(
        t('customize.consumables.removeWhat', { name: item.label }),
        next === null,
      )
    ) {
      await save(next)
    }
  }
  const seed = dialog !== null && dialog !== 'add' ? seedOf(read, dialog) : null
  return (
    <>
      <CustomizeCard
        id={props.cap}
        icon={ICONS[props.cap]}
        title={title}
        testId={`keyed-card-${props.cap}`}
        actions={<Badge>{badgeText}</Badge>}
      >
        <div className="flex flex-col gap-2 px-3 py-2 sm:px-4">
          {props.defaults.kind === 'known' && (
            <NativeItemRows deviceId={props.device.id} defaults={props.defaults.value} />
          )}
          {props.defaults.kind === 'unknown' && (
            <ErrorBox
              title={t('customize.consumables.builtIn')}
              message={t('customize.consumables.builtInUnreadable', {
                reason: props.defaults.reason,
              })}
            />
          )}
          {read?.items.map((item) => (
            <AssignedRow
              key={item.key}
              deviceId={props.device.id}
              cap={props.cap}
              item={item}
              language={i18n.language}
              sourceName={sourceName(item, devices)}
              saving={props.handle.saving}
              onChange={() => setDialog(item.key)}
              onRemove={() => void removeItem(item)}
              handle={props.handle}
            />
          ))}
          {error !== null && (
            <p role="alert" className="text-xs text-danger break-words">
              {error}
            </p>
          )}
          {canAdd && (
            <Button
              variant="outline"
              size="sm"
              data-testid={`keyed-add-${props.cap}`}
              disabled={props.handle.saving}
              onClick={() => setDialog('add')}
            >
              {t('customize.keyed.add')}
            </Button>
          )}
        </div>
      </CustomizeCard>
      <KeyedArrayItemDialog
        open={dialog !== null}
        mode={dialog === 'add' ? 'add' : 'change'}
        cap={props.cap}
        targetId={props.target.id}
        host={props.device}
        target={props.handle.target}
        apply={apply}
        seed={seed}
        canSave={answered && !props.handle.saving}
        onClose={() => setDialog(null)}
        onSave={(feature, key) => {
          if (
            dialog === 'add' &&
            storedFeature?.items !== undefined &&
            storedFeature.items[key] !== undefined
          ) {
            setError(t('customize.keyed.duplicateKey', { key }))
            return
          }
          const merged = mergeKeyedArrayItem(storedFeature, feature, key)
          setDialog(null)
          if (merged === null) return
          setError(null)
          void save(withFeature(current, props.handle.target, merged))
        }}
      />
    </>
  )
}

function AssignedRow(props: {
  readonly deviceId: number
  readonly cap: string
  readonly item: KeyedArrayItemView
  readonly language: string
  readonly sourceName: string | null
  readonly saving: boolean
  readonly onChange: () => void
  readonly onRemove: () => void
  readonly handle: CustomizationHandle
}): ReactNode {
  const { t } = useTranslation()
  const compile = props.item.compile
  const recognized = props.item.recognized && compile !== null
  const field =
    compile === null
      ? ''
      : vocabularyFieldLabel(
          compile.draft.source.cap,
          compile.draft.source.fieldPath,
          props.language,
        )
  const detail = recognized
    ? [props.sourceName ?? '', field].filter((part) => part.length > 0).join(' · ')
    : t('customize.consumables.otherFormula')
  const path =
    compile === null
      ? null
      : compositionItemFieldPath(
          COMPOSITION_ITEM_ARRAY_PATH,
          props.item.key,
          compile.draft.fieldPath,
        )
  return (
    <div className="flex flex-col gap-1" data-testid={`keyed-row-${props.item.key}`}>
      <AssignmentRow
        name={props.item.label}
        detail={detail}
        meta={recognized ? t('customize.keyed.assigned') : null}
        value={path === null ? null : { deviceId: props.deviceId, cap: props.cap, path }}
        readout={
          path === null ? null : (
            <LiveValueText target={{ deviceId: props.deviceId, cap: props.cap, path }} />
          )
        }
        removeLabel=""
      />
      <div className="flex flex-wrap gap-2">
        {recognized && (
          <Button variant="outline" size="sm" disabled={props.saving} onClick={props.onChange}>
            {t('customize.keyed.change')}
          </Button>
        )}
        {recognized && (
          <Button variant="ghost" size="sm" disabled={props.saving} onClick={props.onRemove}>
            {t('customize.keyed.remove')}
          </Button>
        )}
        {!recognized && (
          <FormulaEntryButton
            handle={props.handle}
            cap={props.cap}
            itemKey={props.item.key}
            fieldPath="status"
          />
        )}
      </div>
    </div>
  )
}

function visible(props: KeyedArrayCardProps, stored: CompositionFieldsFeature | null): boolean {
  if (!props.target.deviceTypes.includes(props.device.type)) return false
  if (props.availability.kind !== 'absent') return true
  if (props.defaults.kind !== 'known') return true
  if (props.defaults.value.length > 0) return true
  return stored !== null
}

function storedRead(
  handle: CustomizationHandle,
  feature: CompositionFieldsFeature | null,
): ScalarRead<CompositionFieldsFeature | null> {
  if (handle.state.kind === 'pending') return { kind: 'pending' }
  if (handle.state.kind === 'unknown' || handle.state.kind === 'not-loaded') {
    return { kind: 'unknown', reason: handle.state.reason }
  }
  return { kind: 'known', value: feature }
}

function sourcePresence(
  read: ReturnType<typeof readKeyedArrayItems>,
  devices: Known<readonly CandidateDevice[]>,
): ScalarSourcePresence {
  const recognized = (read?.items ?? []).filter((item) => item.recognized && item.compile !== null)
  if (recognized.length === 0) return 'present'
  if (devices.kind === 'pending') return 'pending'
  if (devices.kind === 'unknown') return 'unknown'
  const found = recognized.every((item) => {
    const source = item.compile?.draft.source
    if (source === undefined) return false
    const key = compositionSourceKey(source)
    return devices.value.some(
      (row) => compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }) === key,
    )
  })
  return found ? 'present' : 'absent'
}

function sourceName(
  item: KeyedArrayItemView,
  devices: ReturnType<typeof useCandidateDevices>,
): string | null {
  const source = item.compile?.draft.source
  if (source === undefined || devices.kind !== 'known') return null
  const key = compositionSourceKey(source)
  return (
    devices.value.find(
      (row) => compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }) === key,
    )?.name ?? null
  )
}

function seedOf(read: ReturnType<typeof readKeyedArrayItems>, key: string): KeyedDialogSeed | null {
  const item = read?.items.find((row) => row.key === key)
  const compile = item?.compile
  if (item === undefined || compile === null || compile === undefined) return null
  return {
    key: item.key,
    label: item.label,
    fieldPath: compile.draft.fieldPath,
    literals: compile.literals,
    source: {
      addonId: compile.draft.source.addonId,
      stableId: compile.draft.source.stableId,
      cap: compile.draft.source.cap,
      fieldPath: compile.draft.source.fieldPath,
      valueKind: compile.sourceValueKind,
    },
    transform: compile.draft.transform,
  }
}

function badgeLabel(t: TFunction, text: string, count: number): string {
  if (text === 'Native') return t('customize.keyed.badge.native')
  if (text === 'pending') return t('customize.keyed.badge.pending')
  if (text === 'unknown') return t('customize.keyed.badge.unknown')
  if (text.endsWith('assigned')) return t('customize.keyed.badge.assigned', { count })
  return text
}

export interface KeyedArrayCustomizeListProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly facts: AssignmentFacts
  readonly defaults: Known<readonly DefaultConsumable[]>
}

export function KeyedArrayCustomizeList(props: KeyedArrayCustomizeListProps): ReactNode {
  return (
    <>
      {keyedArrayCardTargets().map((card) => {
        if (!card.target.deviceTypes.includes(props.device.type)) return null
        return (
          <KeyedArrayCard
            key={card.cap}
            device={props.device}
            handle={props.handle}
            availability={assignmentAvailability(
              offerFromCatalog(card.cap, card.target),
              props.facts,
            )}
            cap={card.cap}
            target={card.target}
            defaults={props.defaults}
          />
        )
      })}
    </>
  )
}
