/**
 * One Customize card for a declared scalar target (battery, running).
 * The badge is the effective authority. An unrecognised formula links to
 * Advanced and is not removed from here.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CompositionFieldsFeature,
  compositionSourceKey,
  type CustomizeCatalogTarget,
  type DeviceInfo,
  decodeScalarOverride,
  projectScalarAssignment,
  scalarTargetCount,
  targetFeature,
  type ScalarRead,
  type ScalarSourcePresence,
} from '@camstack/types'
import {
  Badge,
  Button,
  ErrorBox,
  useDeviceLabel,
  type DeviceNameFields,
} from '@camstack/ui-library'
import { Activity, BatteryMedium, type LucideIcon, Zap } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentAvailability,
  type AssignmentFacts,
  assignmentAvailability,
  offerFromCatalog,
} from '../assignment-availability'
import { FormulaEntryButton } from '../formula/FormulaEntryButton'
import { LiveValueText } from '../assignments/LiveValueText'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { candidateFields } from '../source-selector/source-selector-parent-detail'
import { CustomizeCard } from '../CustomizeCard'
import { currentComposition } from '../customization-read'
import { featureOf, withoutScalarTarget, withScalarTarget } from '../customization-save'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { ScalarOverrideDialog, type ScalarDialogSeed } from './ScalarOverrideDialog'
import { scalarBadge } from './scalar-badge'
import { vocabularyFieldLabel } from '../vocabulary-field-label'

const PLACEHOLDER_DEVICE: DeviceNameFields = {
  id: 0,
  name: '',
  type: 'unknown',
  stableId: '',
  parentDeviceId: null,
}

const ICONS: Readonly<Record<string, LucideIcon>> = {
  battery: BatteryMedium,
  'running-state': Activity,
  'power-meter': Zap,
}

export interface ScalarCardTarget {
  readonly cap: string
  readonly target: CustomizeCatalogTarget
}

export function scalarCardTargets(): readonly ScalarCardTarget[] {
  return Object.entries(CAP_CUSTOMIZE_CATALOG).flatMap(([cap, entry]) =>
    entry.targets
      .filter((target) => target.cardinality === 'scalar')
      .map((target) => ({ cap, target })),
  )
}

export interface ScalarOverrideCardProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly availability: AssignmentAvailability
  readonly cap: string
  readonly target: CustomizeCatalogTarget
}

export function ScalarOverrideCard({
  device,
  handle,
  availability,
  cap,
  target,
}: ScalarOverrideCardProps): ReactNode {
  const { t, i18n } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A cap with several scalar targets (Power and energy) is one extension with
  // a card per reading: they share one stored feature, each owns its slice (D951).
  const shared = scalarTargetCount(cap) > 1
  const path = target.path ?? target.id
  const capTitle = t(`customize.scalar.caps.${cap}`)
  const title = shared
    ? `${capTitle} · ${vocabularyFieldLabel(cap, path, i18n.language)}`
    : capTitle
  const cardKey = shared ? `${cap}.${target.id}` : cap
  const current = currentComposition(handle.state)
  const storedFeature = targetFeature(featureOf(current, cap), cap, target.id)
  const stored = storedRead(handle, storedFeature)
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
            compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }) ===
            compositionSourceKey(decoded.draft.source),
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
  const badge = scalarBadge(projection.text, sourceName)
  const answered = handle.state.kind === 'none' || handle.state.kind === 'present'
  const mode = availability.kind === 'present' ? availability.mode : null
  if (availability.kind === 'absent') return null
  if (!target.deviceTypes.includes(device.type)) return null

  const save = async (next: Parameters<CustomizationHandle['save']>[0]): Promise<void> => {
    const outcome = await handle.save(next)
    setError(outcome.kind === 'refused' ? outcome.reason : null)
  }
  const remove = async (): Promise<void> => {
    if (current === null) return
    const next = withoutScalarTarget(current, cap, target.id)
    const named =
      sourceName ?? (decoded === null ? hostLabel : compositionSourceKey(decoded.draft.source))
    if (await confirmRemove(t('customize.scalar.removeWhat', { name: named }), next === null)) {
      await save(next)
    }
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
  const badgeText =
    badge.kind === 'assigned'
      ? t('customize.scalar.badge.assigned', { source: badge.source })
      : t(`customize.scalar.badge.${badge.kind}`)

  return (
    <>
      <CustomizeCard
        id={cardKey}
        icon={ICONS[cap]}
        title={title}
        testId={`scalar-card-${cardKey}`}
        actions={<Badge>{badgeText}</Badge>}
      >
        <CardBody
          availability={availability}
          answered={answered}
          deviceId={device.id}
          cap={cap}
          cardKey={cardKey}
          path={path}
          recognized={recognized}
          stored={stored}
          presence={presence}
          released={projection.status.state === 'released'}
          sourceName={sourceName}
          sourceCap={decoded?.draft.source.cap ?? ''}
          sourceField={
            decoded === null
              ? ''
              : vocabularyFieldLabel(
                  decoded.draft.source.cap,
                  decoded.draft.source.fieldPath,
                  i18n.language,
                )
          }
          sourcePath={decoded?.draft.source.fieldPath ?? ''}
          sourceDeviceId={sourceDevice?.id ?? null}
          error={error}
          saving={handle.saving}
          mode={mode}
          onOpen={() => setOpen(true)}
          onRemove={() => void remove()}
          handle={handle}
        />
      </CustomizeCard>
      {mode !== null && (
        <ScalarOverrideDialog
          open={open}
          mode={seed === null ? 'add' : 'change'}
          title={title}
          cap={cap}
          targetId={target.id}
          host={device}
          target={handle.target}
          apply={mode}
          seed={seed}
          canSave={answered && !handle.saving}
          onClose={() => setOpen(false)}
          onSave={(feature) => {
            setOpen(false)
            void save(withScalarTarget(current, handle.target, feature, cap, target.id))
          }}
        />
      )}
    </>
  )
}

interface CardBodyProps {
  readonly availability: AssignmentAvailability
  readonly answered: boolean
  readonly deviceId: number
  readonly cap: string
  readonly cardKey: string
  readonly path: string
  readonly recognized: boolean
  readonly stored: ScalarRead<CompositionFieldsFeature | null>
  readonly presence: ScalarSourcePresence
  readonly released: boolean
  readonly sourceName: string | null
  readonly sourceCap: string
  readonly sourceField: string
  readonly sourcePath: string
  readonly sourceDeviceId: number | null
  readonly error: string | null
  readonly saving: boolean
  readonly mode: 'add' | 'replace' | null
  readonly onOpen: () => void
  readonly onRemove: () => void
  readonly handle: CustomizationHandle
}

function CardBody(props: CardBodyProps): ReactNode {
  const { t } = useTranslation()
  if (
    props.availability.kind === 'pending' ||
    (props.availability.kind === 'present' && !props.answered)
  ) {
    return (
      <p role="status" className="px-3 py-2 text-xs text-foreground-subtle sm:px-4">
        {t('customize.scalar.checking')}
      </p>
    )
  }
  if (props.availability.kind === 'unknown') {
    return (
      <div className="px-3 py-2 sm:px-4">
        <ErrorBox title={t('customize.scalar.unreadable')} message={props.availability.reason} />
      </div>
    )
  }
  const noOverride = props.stored.kind === 'known' && props.stored.value === null
  const other = !props.recognized && props.stored.kind === 'known' && props.stored.value !== null
  return (
    <div className="flex flex-col gap-2 px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-foreground">{t('customize.scalar.effective')}</span>
        <LiveValueText target={{ deviceId: props.deviceId, cap: props.cap, path: props.path }} />
      </div>
      {props.released && (
        <p className="text-xs text-foreground">{t('customize.scalar.released')}</p>
      )}
      {props.presence === 'unknown' && props.recognized && (
        <ErrorBox
          title={t('customize.scalar.sourceUnreadable')}
          message={t('customize.scalar.sourceHeld', { name: props.sourceName ?? props.sourceCap })}
        />
      )}
      {props.recognized && !props.released && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs text-foreground">
            {t('customize.scalar.override', {
              name: props.sourceName ?? '…',
              field: props.sourceField,
            })}
          </span>
          {props.sourceDeviceId !== null && (
            <LiveValueText
              target={{
                deviceId: props.sourceDeviceId,
                cap: props.sourceCap,
                path: props.sourcePath,
              }}
            />
          )}
        </div>
      )}
      {other && (
        <p className="text-xs text-foreground flex flex-wrap items-center gap-1">
          {t('customize.scalar.otherFormula')}
          <FormulaEntryButton handle={props.handle} cap={props.cap} fieldPath={props.path} />
        </p>
      )}
      {noOverride && (
        <p className="text-xs text-foreground-subtle">{t('customize.scalar.noOverride')}</p>
      )}
      {props.error !== null && (
        <p role="alert" className="text-xs text-danger break-words">
          {props.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {props.recognized && (
          <Button
            variant="outline"
            size="sm"
            data-testid={`scalar-change-${props.cardKey}`}
            onClick={props.onOpen}
            disabled={props.saving}
          >
            {props.released ? t('customize.scalar.chooseAnother') : t('customize.scalar.change')}
          </Button>
        )}
        {props.recognized && (
          <Button variant="ghost" size="sm" onClick={props.onRemove} disabled={props.saving}>
            {t('customize.scalar.remove')}
          </Button>
        )}
        {noOverride && (
          <Button
            variant="outline"
            size="sm"
            data-testid={`scalar-add-${props.cardKey}`}
            disabled={props.saving || props.mode === null}
            onClick={props.onOpen}
          >
            {t('customize.scalar.add')}
          </Button>
        )}
      </div>
    </div>
  )
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
  recognized: boolean,
  devices: 'pending' | 'unknown' | 'known',
  found: boolean,
): ScalarSourcePresence {
  if (!recognized) return 'present'
  if (devices === 'pending') return 'pending'
  if (devices === 'unknown') return 'unknown'
  return found ? 'present' : 'absent'
}

export interface ScalarCustomizeListProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly facts: AssignmentFacts
}

export function ScalarCustomizeList({
  device,
  handle,
  facts,
}: ScalarCustomizeListProps): ReactNode {
  return (
    <>
      {scalarCardTargets().map((card) => {
        if (!card.target.deviceTypes.includes(device.type)) return null
        return (
          <ScalarOverrideCard
            key={`${card.cap}.${card.target.id}`}
            device={device}
            handle={handle}
            availability={assignmentAvailability(offerFromCatalog(card.cap, card.target), facts)}
            cap={card.cap}
            target={card.target}
          />
        )
      })}
    </>
  )
}
