/**
 * Everything one scalar Customize row knows: what is stored for the target,
 * the source it reads, the authority badge, and the two writes (change,
 * remove). The Customize table renders it; nothing here draws.
 */
import {
  compositionSourceKey,
  type CompositionFieldsFeature,
  type CustomizeCatalogTarget,
  type DeviceInfo,
  decodeScalarOverride,
  projectScalarAssignment,
  type ScalarRead,
  type ScalarSourcePresence,
  targetFeature,
  scalarTargetCount,
} from '@camstack/types'
import { type DeviceNameFields, useDeviceLabel } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { currentComposition } from '../customization-read'
import { featureOf, withoutScalarTarget, withScalarTarget } from '../customization-save'
import { candidateFields } from '../source-selector/source-selector-parent-detail'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import type { ScalarDialogSeed } from './ScalarOverrideDialog'
import { type ScalarBadge, scalarBadge } from './scalar-badge'

const PLACEHOLDER_DEVICE: DeviceNameFields = {
  id: 0,
  name: '',
  type: 'unknown',
  stableId: '',
  parentDeviceId: null,
}

export interface ScalarRowModel {
  readonly title: string
  readonly path: string
  readonly stored: ScalarRead<CompositionFieldsFeature | null>
  /** The stored feature is a source link the dialog can edit. */
  readonly recognized: boolean
  /** Something is stored for the target but it is another formula (Advanced owns it). */
  readonly otherFormula: boolean
  readonly presence: ScalarSourcePresence
  readonly released: boolean
  readonly badge: ScalarBadge
  readonly sourceName: string | null
  readonly sourceCap: string
  readonly sourcePath: string
  readonly sourceField: string
  readonly sourceDeviceId: number | null
  readonly seed: ScalarDialogSeed | null
  readonly answered: boolean
  readonly saving: boolean
  /** Resolves to the refusal reason, or null when the write was saved (or nothing was written). */
  readonly saveFeature: (feature: CompositionFieldsFeature) => Promise<string | null>
  readonly remove: () => Promise<string | null>
}

export function storedRead(
  handle: CustomizationHandle,
  feature: CompositionFieldsFeature | null,
): ScalarRead<CompositionFieldsFeature | null> {
  if (handle.state.kind === 'pending') return { kind: 'pending' }
  if (handle.state.kind === 'unknown' || handle.state.kind === 'not-loaded') {
    return { kind: 'unknown', reason: handle.state.reason }
  }
  return { kind: 'known', value: feature }
}

/** The stored feature of one scalar target, or null when nothing is stored. */
export function storedScalarFeature(
  handle: CustomizationHandle,
  cap: string,
  targetId: string,
): CompositionFieldsFeature | null {
  return targetFeature(featureOf(currentComposition(handle.state), cap), cap, targetId)
}

function sourcePresence(
  recognized: boolean,
  devices: 'pending' | 'unknown' | 'known',
  found: boolean,
): ScalarSourcePresence {
  if (!recognized) return 'present'
  if (devices === 'pending') return 'pending'
  if (devices === 'unknown') return 'unknown'
  return found ? 'present' : 'absent'
}

/** The row's title: the cap, plus the reading when one cap carries several scalar targets. */
export function scalarRowTitle(
  t: (key: string) => string,
  language: string,
  cap: string,
  target: CustomizeCatalogTarget,
): string {
  const capTitle = t(`customize.scalar.caps.${cap}`)
  if (scalarTargetCount(cap) <= 1) return capTitle
  return `${capTitle} · ${vocabularyFieldLabel(cap, target.path ?? target.id, language)}`
}

export function useScalarRow(
  device: DeviceInfo,
  handle: CustomizationHandle,
  cap: string,
  target: CustomizeCatalogTarget,
): ScalarRowModel {
  const { t, i18n } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const path = target.path ?? target.id
  const title = scalarRowTitle(t, i18n.language, cap, target)
  const current = currentComposition(handle.state)
  const stored = storedRead(handle, storedScalarFeature(handle, cap, target.id))
  const decoded =
    stored.kind === 'known' && stored.value !== null
      ? decodeScalarOverride({
          feature: stored.value,
          device: handle.target,
          cap,
          targetId: target.id,
        })
      : null
  const recognized = decoded !== null
  const devices = useCandidateDevices(recognized)
  const sourceDevice =
    decoded === null || devices.kind !== 'known'
      ? null
      : (devices.value.find(
          (row) =>
            compositionSourceKey({
              addonId: row.addonId,
              stableId: row.stableId,
            }) === compositionSourceKey(decoded.draft.source),
        ) ?? null)
  const sourceLabel = useDeviceLabel(
    sourceDevice === null ? PLACEHOLDER_DEVICE : candidateFields(sourceDevice),
    'compact',
  )
  const sourceName = sourceDevice === null ? null : sourceLabel
  const hostLabel = useDeviceLabel(device, 'full')
  const presence = sourcePresence(recognized, devices.kind, sourceDevice !== null)
  const projection = projectScalarAssignment({
    cap,
    targetId: target.id,
    device: handle.target,
    stored,
    sourcePresence: presence,
    sourceUnknownReason: devices.kind === 'unknown' ? devices.reason : null,
  })
  const save = async (next: Parameters<CustomizationHandle['save']>[0]): Promise<string | null> => {
    const outcome = await handle.save(next)
    return outcome.kind === 'refused' ? outcome.reason : null
  }
  const remove = async (): Promise<string | null> => {
    if (current === null) return null
    const next = withoutScalarTarget(current, cap, target.id)
    const named =
      sourceName ?? (decoded === null ? hostLabel : compositionSourceKey(decoded.draft.source))
    if (await confirmRemove(t('customize.scalar.removeWhat', { name: named }), next === null)) {
      return save(next)
    }
    return null
  }
  const seed: ScalarDialogSeed | null =
    decoded === null
      ? null
      : {
          source: {
            addonId: decoded.draft.source.addonId,
            stableId: decoded.draft.source.stableId,
            cap: decoded.draft.source.cap,
            fieldPath: decoded.draft.source.fieldPath,
            valueKind: decoded.sourceValueKind,
            sourceUnit: decoded.sourceUnit,
            changedAtField: decoded.changedAtField,
          },
          transform: decoded.draft.transform,
        }
  return {
    title,
    path,
    stored,
    recognized,
    otherFormula: !recognized && stored.kind === 'known' && stored.value !== null,
    presence,
    released: projection.status.state === 'released',
    badge: scalarBadge(projection.text, sourceName),
    sourceName,
    sourceCap: decoded?.draft.source.cap ?? '',
    sourcePath: decoded?.draft.source.fieldPath ?? '',
    sourceField:
      decoded === null
        ? ''
        : vocabularyFieldLabel(
            decoded.draft.source.cap,
            decoded.draft.source.fieldPath,
            i18n.language,
          ),
    sourceDeviceId: sourceDevice?.id ?? null,
    seed,
    answered: handle.state.kind === 'none' || handle.state.kind === 'present',
    saving: handle.saving,
    saveFeature: (feature) =>
      save(withScalarTarget(current, handle.target, feature, cap, target.id)),
    remove,
  }
}
