import type { CamProfile, RecordingConfig } from '@camstack/types'
import {
  RECORDING_SOURCE_CAMSTACK_ADDON,
  RecordingConfigSchema,
  RecordingStatusSchema,
  selectAssignedProfileSlots,
} from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import {
  CircleDot,
  Clock,
  Film,
  HardDrive,
  Radio,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react'
import { useCallback, useMemo, type JSX } from 'react'
import {
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
  useRecordingArchiveGetDeviceConfig,
  useRecordingArchiveGetStatus,
  useRecordingArchiveRescanStorage,
  useRecordingArchiveSetDeviceConfig,
  useRecordingGetAvailability,
  useStreamBrokerListAllProfileSlots,
} from '../../generated/system-hooks'
import { useUiText } from '../../contexts/ui-text'
import { formatDurationMs } from '../../lib/format-duration.js'
import type { HostWidgetProps } from '../../widgets/host-widgets'
import { ErrorBox } from '../error-box'
import { WidgetMetricCard, WidgetPanel } from '../widget-panel'
import type { DeviceSignalPresence } from './RecordingBandsEditor'
import { RecordingSettings } from './RecordingSettings'
import { RecordingTimeline } from './RecordingTimeline'
import { formatBytes } from './recording-spans'

const DAY_MS = 24 * 60 * 60 * 1000

export function RecordingPanel({ deviceId }: HostWidgetProps): JSX.Element {
  const t = useUiText()
  const queryClient = useQueryClient()
  const statusQuery = useRecordingArchiveGetStatus({ deviceId })
  const configQuery = useRecordingArchiveGetDeviceConfig({ deviceId })
  // The camera's own row, for the sensor picker's location suggestion (D356
  // spirit: suggest the same location, never link on its own).
  const deviceQuery = useDeviceManagerGetDevice({ deviceId })
  const cameraLocation = deviceQuery.data?.location ?? null
  // Does this camera publish its own `recording-signal`? Asked of ITS bindings
  // (D12: per-device, never the global cap list), answered in four states so
  // an unanswered query is never rendered as "no signal" (D315).
  const bindingsQuery = useDeviceManagerGetBindings({ deviceId })
  const deviceSignal: DeviceSignalPresence =
    bindingsQuery.status === 'pending'
      ? 'pending'
      : bindingsQuery.status === 'error'
        ? 'unknown'
        : bindingsQuery.data.entries.some((e) => e.capName === 'recording-signal')
          ? 'present'
          : 'absent'
  const setConfig = useRecordingArchiveSetDeviceConfig()
  const rescanStorage = useRecordingArchiveRescanStorage()
  const { data: profileSlots } = useStreamBrokerListAllProfileSlots(undefined, {
    staleTime: 30_000,
  })
  const availableProfiles = useMemo<readonly CamProfile[]>(
    () => selectAssignedProfileSlots(profileSlots ?? [], deviceId).map((s) => s.profile),
    [profileSlots, deviceId],
  )

  const saveConfig = (config: RecordingConfig): void => {
    setConfig.mutate(
      { deviceId, config },
      {
        onSuccess: () => {
          void configQuery.refetch()
          void statusQuery.refetch()
        },
      },
    )
  }

  const handleForceRefresh = useCallback((): void => {
    rescanStorage.mutate(
      { deviceId },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: [['recording']] })
        },
      },
    )
  }, [deviceId, queryClient, rescanStorage])

  const toMs = useMemo(() => Date.now(), [])
  // OURS, by name. This panel is the recorder's own settings surface: the
  // question it asks is "what has OUR archive got", not "what can this camera
  // show", and `recording` requires the source to be named since D625.
  const availabilityQuery = useRecordingGetAvailability({
    deviceId,
    provider: RECORDING_SOURCE_CAMSTACK_ADDON,
    fromMs: toMs - DAY_MS,
    toMs,
  })

  const parsedStatus = statusQuery.data ? RecordingStatusSchema.safeParse(statusQuery.data) : null
  const status = parsedStatus?.success ? parsedStatus.data : null
  const parsedConfig = configQuery.data ? RecordingConfigSchema.safeParse(configQuery.data) : null
  const resolvedConfig = parsedConfig?.success ? parsedConfig.data : null
  // A read that FAILED carries no ranges and no claim. `read: 'unreadable'`
  // must not be summed to "0 s recorded" beside "0 segment ranges", which is
  // exactly what a camera with recording off looks like (D393, D625).
  const availabilityUnreadable = availabilityQuery.data?.read === 'unreadable'
  const ranges = availabilityQuery.data?.read === 'read' ? availabilityQuery.data.ranges : []
  const recordedMs = ranges.reduce((acc, r) => acc + Math.max(0, r.endMs - r.startMs), 0)
  const isRecording = status?.enabled === true && status.activeMode === 'continuous'

  return (
    <div className="space-y-3">
      <WidgetPanel
        title={t('uiLibrary.recordingPanel.settings', 'Settings')}
        icon={<SettingsIcon className="h-3.5 w-3.5 text-foreground-subtle" />}
      >
        {resolvedConfig ? (
          <RecordingSettings
            key={JSON.stringify(resolvedConfig)}
            initial={resolvedConfig}
            availableProfiles={availableProfiles}
            saving={setConfig.isPending}
            onSave={saveConfig}
            sensorContext={{ cameraId: deviceId, location: cameraLocation, deviceSignal }}
          />
        ) : (
          <div className="px-1 py-2 text-xs text-foreground-subtle">
            {t('uiLibrary.recordingPanel.loadingSettings', 'Loading settings…')}
          </div>
        )}
      </WidgetPanel>

      <WidgetPanel
        title={t('uiLibrary.recordingPanel.recording', 'Recording')}
        icon={<Film className="h-3.5 w-3.5 text-foreground-subtle" />}
        headerRight={
          <span className="flex items-center gap-2">
            {isRecording ? (
              <span className="flex items-center gap-1.5 text-[10px] text-emerald-500">
                <Radio className="h-3 w-3" /> {t('uiLibrary.recordingPanel.recording', 'Recording')}
              </span>
            ) : null}
            <button
              type="button"
              onClick={handleForceRefresh}
              disabled={rescanStorage.isPending}
              aria-label={t('uiLibrary.recordingPanel.rescanStorage', 'Rescan storage')}
              className="flex items-center rounded p-0.5 text-foreground-subtle transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${rescanStorage.isPending ? 'animate-spin' : ''}`}
              />
            </button>
          </span>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <WidgetMetricCard
              label={t('uiLibrary.recordingPanel.status', 'Status')}
              icon={
                <CircleDot className={`h-3.5 w-3.5 ${isRecording ? 'text-emerald-500' : ''}`} />
              }
              footer={
                status?.nodeId
                  ? t('uiLibrary.recordingPanel.nodeFooter', 'node: {{nodeId}}', {
                      nodeId: status.nodeId,
                    })
                  : undefined
              }
            >
              {statusQuery.isLoading
                ? '…'
                : isRecording
                  ? t('uiLibrary.recordingPanel.recordingContinuous', 'Recording (continuous)')
                  : t('uiLibrary.recordingPanel.idle', 'Idle')}
            </WidgetMetricCard>

            <WidgetMetricCard
              label={t('uiLibrary.recordingPanel.storage', 'Storage')}
              icon={<HardDrive className="h-3.5 w-3.5" />}
            >
              {status ? formatBytes(status.storageBytes) : '—'}
            </WidgetMetricCard>

            <WidgetMetricCard
              label={t('uiLibrary.recordingPanel.recorded24h', 'Recorded (24h)')}
              icon={<Clock className="h-3.5 w-3.5" />}
              footer={
                availabilityUnreadable
                  ? t('uiLibrary.recordingPanel.nobodyCouldLook', 'nobody could look')
                  : t(
                      'uiLibrary.recordingPanel.segmentRange',
                      {
                        one: '{{count}} segment range',
                        other: '{{count}} segment ranges',
                      },
                      { count: ranges.length },
                    )
              }
            >
              {availabilityQuery.isLoading
                ? '…'
                : availabilityUnreadable
                  ? '—'
                  : formatDurationMs(recordedMs)}
            </WidgetMetricCard>
          </div>

          {statusQuery.isError ? (
            <ErrorBox
              variant="warning"
              message={t(
                'uiLibrary.recordingPanel.recorderUnavailable',
                'Recorder unavailable — the recording service may not be running for this node.',
              )}
            />
          ) : null}

          <RecordingTimeline deviceId={deviceId} />

          <p className="text-[11px] text-foreground-subtle">
            {t(
              'uiLibrary.recordingPanel.playbackHint',
              'Recordings play in the main player above — switch back to live from there.',
            )}
          </p>
        </div>
      </WidgetPanel>
    </div>
  )
}
