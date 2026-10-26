/**
 * One pulse card. The feature is a composition claim; the header checkbox is
 * that feature's `enabled`. A formula this card did not write links to Advanced.
 */
import {
  compositionSourceKey,
  type CompositionFieldsFeature,
  type DeviceInfo,
  decodePulseOverride,
  projectPulseAssignment,
  type ScalarRead,
  type ScalarSourcePresence,
} from '@camstack/types'
import { Badge, Button, Checkbox, ErrorBox } from '@camstack/ui-library'
import { BellRing } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentAvailability } from '../assignment-availability'
import { FormulaEntryButton } from '../formula/FormulaEntryButton'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { useLiveValue } from '../assignments/use-live-value'
import { CustomizeCard } from '../CustomizeCard'
import { currentComposition } from '../customization-read'
import { featureOf, withFeature, withoutFeature } from '../customization-save'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'
import { formatRelativeTime } from '../../hero/format'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { EventPulseDialog } from './EventPulseDialog'
import type { PulseFormSource } from './event-form'
import { doorbellRingStatus } from './event-status-text'
import { eventBadgeKey, type PulseCatalogView } from './event-targets'

export interface EventPulseCardProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly availability: AssignmentAvailability
  readonly cap: string
  readonly title: string
  readonly view: PulseCatalogView
}

export function EventPulseCard({
  device,
  handle,
  availability,
  cap,
  title,
  view,
}: EventPulseCardProps): ReactNode {
  const { t, i18n } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = currentComposition(handle.state)
  const storedFeature = featureOf(current, cap)
  const stored = storedRead(handle, storedFeature)
  const decoded =
    stored.kind === 'known' && stored.value !== null
      ? decodePulseOverride({
          feature: stored.value,
          device: handle.target,
          cap,
          targetId: view.id,
          timestampPath: view.timestampPath,
          counterPath: view.counterPath,
        })
      : null
  const recognized = decoded !== null
  const devices = useCandidateDevices(recognized)
  const source = decoded?.draft.sources[0] ?? null
  const sourceDevice =
    source === null || devices.kind !== 'known'
      ? null
      : (devices.value.find(
          (row) =>
            compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }) ===
            compositionSourceKey(source),
        ) ?? null)
  const presence = sourcePresence(recognized, devices.kind, sourceDevice !== null)
  const projection = projectPulseAssignment({
    cap,
    targetId: view.id,
    device: handle.target,
    timestampPath: view.timestampPath,
    counterPath: view.counterPath,
    apply: view.apply,
    stored,
    sourcePresence: presence,
    sourceUnknownReason: devices.kind === 'unknown' ? devices.reason : null,
  })
  const answered = handle.state.kind === 'none' || handle.state.kind === 'present'
  if (availability.kind === 'absent') return null
  if (!view.deviceTypes.includes(device.type)) return null

  const save = async (next: Parameters<CustomizationHandle['save']>[0]): Promise<void> => {
    const outcome = await handle.save(next)
    setError(outcome.kind === 'refused' ? outcome.reason : null)
  }
  const seedSources = pulseSources(decoded)
  const storedEdge = decoded?.draft.edges?.[0]
  const edge =
    storedEdge !== undefined && view.edges.includes(storedEdge) ? storedEdge : view.defaultEdge
  const fieldLabel =
    source === null ? '' : vocabularyFieldLabel(source.cap, source.fieldPath, i18n.language)
  const noOverride = stored.kind === 'known' && stored.value === null
  const other = !recognized && stored.kind === 'known' && stored.value !== null

  return (
    <>
      <CustomizeCard
        id={cap}
        icon={BellRing}
        title={title}
        testId={`event-card-${cap}`}
        actions={
          <>
            {storedFeature !== null && (
              <label className="flex items-center gap-1.5 text-[11px] text-foreground">
                <Checkbox
                  aria-label={t('customize.doorbell.active')}
                  checked={storedFeature.enabled !== false}
                  disabled={!answered || handle.saving}
                  onChange={(event) => {
                    void save(
                      withFeature(current, handle.target, {
                        ...storedFeature,
                        enabled: event.target.checked,
                      }),
                    )
                  }}
                />
                {t('customize.doorbell.active')}
              </label>
            )}
            <Badge>{t(eventBadgeKey(projection.text, projection.status.state))}</Badge>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-3 py-2 sm:px-4">
          {availability.kind === 'pending' || (availability.kind === 'present' && !answered) ? (
            <p role="status" className="text-xs text-foreground-subtle">
              {t('customize.event.checking')}
            </p>
          ) : availability.kind === 'unknown' ? (
            <ErrorBox title={t('customize.scalar.unreadable')} message={availability.reason} />
          ) : (
            <>
              {recognized && source !== null && (
                <p className="text-xs text-foreground">
                  {t('customize.scalar.override', {
                    name: sourceDevice?.name ?? source.stableId,
                    field: fieldLabel,
                  })}
                </p>
              )}
              {recognized && (
                <DoorbellRingStatus
                  deviceId={device.id}
                  cap={cap}
                  timestampPath={view.timestampPath}
                  counterPath={view.counterPath}
                  startedAt={
                    handle.state.kind === 'present' ? handle.state.view.block.createdAt : null
                  }
                />
              )}
              {other && storedFeature !== null && (
                <p className="text-xs text-foreground flex flex-wrap items-center gap-1">
                  {t('customize.doorbell.otherFormula')}
                  <FormulaEntryButton handle={handle} cap={cap} fieldPath={view.counterPath} />
                </p>
              )}
              {noOverride && (
                <p className="text-xs text-foreground-subtle">{t('customize.scalar.noOverride')}</p>
              )}
              {error !== null && (
                <p role="alert" className="text-xs text-danger break-words">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {recognized && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={handle.saving}
                    onClick={() => setOpen(true)}
                  >
                    {t('customize.scalar.change')}
                  </Button>
                )}
                {recognized && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={handle.saving}
                    onClick={() => {
                      if (current === null) return
                      const next = withoutFeature(current, cap)
                      void confirmRemove(
                        t('customize.doorbell.removeWhat', {
                          name: sourceDevice?.name ?? device.name,
                        }),
                        next === null,
                      ).then((ok) => {
                        if (ok) void save(next)
                      })
                    }}
                  >
                    {t('customize.scalar.remove')}
                  </Button>
                )}
                {noOverride && (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`event-add-${cap}`}
                    disabled={handle.saving}
                    onClick={() => setOpen(true)}
                  >
                    {t('customize.scalar.add')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </CustomizeCard>
      <EventPulseDialog
        open={open}
        mode={recognized ? 'change' : 'add'}
        title={title}
        cap={cap}
        targetId={view.id}
        host={device}
        target={handle.target}
        enabled={storedFeature?.enabled !== false}
        debounceMs={decoded?.draft.debounceMs ?? view.debounceMs}
        edges={view.edges}
        edge={edge}
        sources={seedSources}
        canSave={answered && !handle.saving}
        onClose={() => setOpen(false)}
        onSave={(feature) => {
          setOpen(false)
          void save(withFeature(current, handle.target, feature))
        }}
      />
    </>
  )
}

interface DoorbellRingStatusProps {
  readonly deviceId: number
  readonly cap: string
  readonly timestampPath: string
  readonly counterPath: string
  readonly startedAt: number | null
}

function DoorbellRingStatus({
  deviceId,
  cap,
  timestampPath,
  counterPath,
  startedAt,
}: DoorbellRingStatusProps): ReactNode {
  const { t } = useTranslation()
  const last = useLiveValue({ deviceId, cap, path: timestampPath })
  const count = useLiveValue({ deviceId, cap, path: counterPath })
  const lastRead =
    last.kind === 'pending'
      ? 'pending'
      : last.kind !== 'value' || typeof last.value !== 'number'
        ? 'unknown'
        : last.value
  const countRead = count.kind === 'value' && typeof count.value === 'number' ? count.value : null
  const status = doorbellRingStatus(lastRead, countRead)
  if (status.kind === 'pending') {
    return (
      <p role="status" className="text-[11px] text-foreground-subtle">
        {t('customize.event.checking')}
      </p>
    )
  }
  if (status.kind === 'unknown') {
    return (
      <p role="status" className="text-[11px] text-foreground-subtle">
        {t('customize.event.doorbellLast.unknown')}
      </p>
    )
  }
  if (status.kind === 'none') {
    return (
      <p role="status" className="text-[11px] text-foreground-subtle">
        {t('customize.event.doorbellLast.none', {
          when: startedAt === null ? '' : formatRelativeTime(startedAt),
        })}
        {status.pressCount !== null
          ? ` · ${t('customize.event.doorbellCount', { count: status.pressCount })}`
          : ''}
      </p>
    )
  }
  const when = formatRelativeTime(status.lastPressedAt)
  return (
    <p role="status" className="text-[11px] text-foreground">
      {t('customize.event.doorbellLast.ring', { when })}
      {status.pressCount !== null
        ? ` · ${t('customize.event.doorbellCount', { count: status.pressCount })}`
        : ''}
    </p>
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

function pulseSources(decoded: ReturnType<typeof decodePulseOverride>): readonly PulseFormSource[] {
  if (decoded === null) return []
  return decoded.draft.sources.map((source, index) => ({
    addonId: source.addonId,
    stableId: source.stableId,
    cap: source.cap,
    fieldPath: source.fieldPath,
    changedAtField: decoded.changedAtFields[index] ?? '',
  }))
}
