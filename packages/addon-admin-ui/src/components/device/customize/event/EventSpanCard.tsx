/**
 * A span whose authority is the camera's attached sensors. The list is written
 * only after it was read (D49). Timeout is the camera's `motionCooldownMs`.
 */
import type { DeviceInfo, SpanCompiled, SpanSensorRow } from '@camstack/types'
import { projectSpanAssignment, type SpanRead } from '@camstack/types'
import {
  Badge,
  Button,
  ErrorBox,
  useAddonSettingsGetDeviceSettings,
  useDeviceNameNouns,
  usePipelineOrchestratorApplyDeviceSettingsPatch,
  usePipelineOrchestratorSetCameraSensors,
} from '@camstack/ui-library'
import { Activity } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentAvailability } from '../assignment-availability'
import type { CandidateDevice } from '../assignments/assignment-candidates'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import { useLiveValue } from '../assignments/use-live-value'
import { CustomizeCard } from '../CustomizeCard'
import { candidateFields, sourceRowLabel } from '../source-selector/source-selector-parent-detail'
import { extractOrchestratorCameraSettings } from '../../../pipeline/cameras/camera-card-model'
import type { CameraSensorsRead } from '../use-camera-sensors-presence'
import { applySpan, type SpanFormSource } from './event-form'
import { EventSpanDialog } from './EventSpanDialog'
import { motionNowStatus } from './event-status-text'
import { eventBadgeKey, type SpanCatalogView } from './event-targets'

export interface EventSpanCardProps {
  readonly device: DeviceInfo
  readonly availability: AssignmentAvailability
  readonly cap: string
  readonly title: string
  readonly view: SpanCatalogView
  readonly sensors: CameraSensorsRead
}

export function EventSpanCard({
  device,
  availability,
  cap,
  title,
  view,
  sensors,
}: EventSpanCardProps): ReactNode {
  const { t } = useTranslation()
  const writeSensors = usePipelineOrchestratorSetCameraSensors()
  const writeTimeout = usePipelineOrchestratorApplyDeviceSettingsPatch()
  const settings = useAddonSettingsGetDeviceSettings({
    addonId: 'pipeline-orchestrator',
    deviceId: device.id,
    nodeId: 'hub',
  })
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const [holding, setHolding] = useState(false)
  const read = spanRead(sensors)
  const fleet = useCandidateDevices(true)
  const projection = projectSpanAssignment(view.id, read)
  const timeoutMs = timeoutFrom(
    extractOrchestratorCameraSettings(settings.data).motionCooldownMs,
    view.timeoutMs,
  )
  if (availability.kind === 'absent') return null
  if (!view.deviceTypes.includes(device.type)) return null
  const busy = holding || writeSensors.isPending || writeTimeout.isPending
  const canSave = projection.writable && !busy && availability.kind === 'present'

  const save = async (compiled: SpanCompiled): Promise<void> => {
    if (!projection.writable || inFlight.current) {
      setError(t('customize.saveInFlight'))
      return
    }
    inFlight.current = true
    setHolding(true)
    try {
      await applySpan(
        device.id,
        compiled,
        async (input) => {
          await writeSensors.mutateAsync({
            deviceId: input.deviceId,
            config:
              input.config === null
                ? null
                : {
                    sensors: input.config.sensors.map((sensor) => ({
                      addonId: sensor.addonId,
                      stableId: sensor.stableId,
                      mode: sensor.mode,
                    })),
                  },
          })
        },
        async (input) => {
          const patch: Record<string, unknown> = {
            motionCooldownMs: input.patch.motionCooldownMs,
          }
          await writeTimeout.mutateAsync({ deviceId: input.deviceId, patch })
        },
      )
      setError(null)
      if ((await sensors.refetch()) === 'failed') setError(t('customize.motion.refetchFailed'))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setHolding(false)
    }
  }

  const sources: readonly SpanFormSource[] = projection.rows.map((row) => ({
    addonId: row.addonId,
    stableId: row.stableId,
    cap: 'binary',
    fieldPath: 'on',
    mode: row.mode,
    label: row.name,
  }))

  return (
    <>
      <CustomizeCard
        id={cap}
        icon={Activity}
        title={title}
        testId={`event-card-${cap}`}
        actions={<Badge>{t(eventBadgeKey(projection.text, projection.status.state))}</Badge>}
      >
        <div className="flex flex-col gap-2 px-3 py-2 sm:px-4">
          {availability.kind === 'pending' || read.kind === 'pending' ? (
            <p role="status" className="text-xs text-foreground-subtle">
              {t('customize.motion.reading')}
            </p>
          ) : availability.kind === 'unknown' || read.kind === 'unknown' ? (
            <SensorsUnreadable
              reason={
                readReason(read) || (availability.kind === 'unknown' ? availability.reason : '')
              }
            />
          ) : (
            <>
              <MotionNowLine deviceId={device.id} />
              {projection.rows.length === 0 ? (
                <p className="text-xs text-foreground-subtle">{t('customize.scalar.noOverride')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {projection.rows.map((row) => (
                    <li key={row.key} className="text-xs text-foreground">
                      <SensorRowName row={row} fleet={fleet} />
                      {row.reason !== null ? ` — ${t(`customize.motion.state.${row.state}`)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-foreground-subtle">
                {t('customize.event.timeoutSeconds', { seconds: timeoutMs / 1000 })}
              </p>
              {error !== null && (
                <p role="alert" className="text-xs text-danger break-words">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`event-add-${cap}`}
                  disabled={!canSave}
                  onClick={() => setOpen(true)}
                >
                  {projection.rows.length === 0
                    ? t('customize.scalar.add')
                    : t('customize.scalar.change')}
                </Button>
              </div>
            </>
          )}
        </div>
      </CustomizeCard>
      <EventSpanDialog
        open={open}
        mode={projection.rows.length === 0 ? 'add' : 'change'}
        title={title}
        cap={cap}
        targetId={view.id}
        host={device}
        target={{ addonId: device.addonId, stableId: device.stableId }}
        timeoutMs={timeoutMs}
        cooldownMs={view.cooldownMs}
        sourceModes={view.sourceModes}
        sources={sources}
        canSave={canSave}
        onClose={() => setOpen(false)}
        onSave={(compiled) => {
          setOpen(false)
          void save(compiled)
        }}
      />
    </>
  )
}

interface MotionNowLineProps {
  readonly deviceId: number
}

function MotionNowLine({ deviceId }: MotionNowLineProps): ReactNode {
  const { t } = useTranslation()
  const detected = useLiveValue({ deviceId, cap: 'motion', path: 'detected' })
  const lastAt = useLiveValue({ deviceId, cap: 'motion', path: 'lastDetectedAt' })
  const detectedRead =
    detected.kind === 'pending'
      ? 'pending'
      : detected.kind !== 'value' || typeof detected.value !== 'boolean'
        ? 'unknown'
        : detected.value
  const lastRead = lastAt.kind === 'value' && typeof lastAt.value === 'number' ? lastAt.value : null
  const status = motionNowStatus(detectedRead, lastRead, Date.now())
  const key =
    status.kind === 'active'
      ? 'customize.event.motionNow.active'
      : `customize.event.motionNow.${status.kind}`
  return (
    <p role="status" className="text-xs text-foreground">
      {t(key, status.seconds === null ? undefined : { seconds: status.seconds })}
    </p>
  )
}

function spanRead(sensors: CameraSensorsRead): SpanRead {
  if (sensors.presence === 'pending') return { kind: 'pending' }
  if (sensors.status === null) return { kind: 'unknown', reason: sensors.failureReason }
  return { kind: 'known', value: sensors.status }
}

interface SensorsUnreadableProps {
  readonly reason: string
}

function SensorsUnreadable({ reason }: SensorsUnreadableProps): ReactNode {
  const { t } = useTranslation()
  const named = reason.trim()
  if (named.length === 0) {
    return <ErrorBox message={t('customize.motion.unreadableBare')} />
  }
  return <ErrorBox title={t('customize.motion.unreadable', { reason: named })} message={named} />
}

interface SensorRowNameProps {
  readonly row: SpanSensorRow
  readonly fleet: Known<readonly CandidateDevice[]>
}

function SensorRowName({ row, fleet }: SensorRowNameProps): ReactNode {
  const nouns = useDeviceNameNouns()
  if (fleet.kind !== 'known') return row.name
  const device = fleet.value.find(
    (entry) => entry.addonId === row.addonId && entry.stableId === row.stableId,
  )
  if (device === undefined) return row.name
  return sourceRowLabel(candidateFields(device), fleet.value.map(candidateFields), nouns)
}

function readReason(read: SpanRead): string {
  if (read.kind === 'unknown') return read.reason ?? ''
  if (read.kind === 'known' && read.value.state === 'unreadable') return read.value.reason
  return ''
}

function timeoutFrom(cooldownMs: number | null, fallback: number): number {
  return cooldownMs !== null && Number.isFinite(cooldownMs) ? cooldownMs : fallback
}
