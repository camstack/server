/**
 * Alarm — the panel as it is now, what each mode actually arms, and its three
 * durations.
 *
 * The durations existed in the state machine from the day the panel shipped
 * and had NO editor, so the exit delay was 30 s on every install and nobody
 * could change it.
 *
 * The coverage is the one that matters. "Away armed" is a promise, and an
 * operator has had no way to check it: the only thing that makes the panel do
 * anything is a rule gated on its state, so a mode with no such rule arms
 * nothing at all — silently. This page DERIVES that list from the rules in
 * force on every read (never a stored copy, which would go stale the first
 * time a rule is disabled) and says so in words, including the empty case.
 *
 * Since D630 the page also ARMS: the live card (`alarm-live-card.tsx`) shows a
 * refused arm's open devices and offers Arm anyway bound to that refusal, and
 * each mode card (`alarm-mode-card.tsx`) edits which covered devices may be
 * open when that mode arms. Notifications are delivered only by alarm-family
 * rules — the panel no longer has its own recipients list.
 *
 * A node with no panel gets an explanation, not a form: the hub owns the one
 * panel, and an editor whose Save goes nowhere is worse than an absence.
 */

import {
  type AlarmArmMode,
  alarmPatchLanded,
  NC_ALARM_SENSORS_MAX,
  type NcAlarmConfig,
  type NcAlarmDelayField,
  type NcAlarmNotifyField,
  type NcAlarmPostTriggeredAction,
  type NcAlarmSensors,
  type NcAlarmSettingsPatch,
  type NcSchedule,
} from '@camstack/types'
import {
  Card,
  ErrorBox,
  Tabs,
  TabsList,
  TabsTrigger,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { AlarmLiveCard } from './alarm-live-card'
import { AlarmModeCard, type AlarmOpeningsCheck } from './alarm-mode-card'
import { AlarmProfileBar } from './alarm-profile-bar'
import {
  ALARM_OPENING_CAP_NAMES,
  alarmDeviceNames,
  hubDeviceName,
  nonBlockingOptions,
} from './alarm-nonblocking.helpers'
import {
  type AlarmSensorRow,
  type AlarmSensorsRead,
  type AlarmSwitchWrite,
  alarmSensorReadChunks,
  alarmSensorRows,
  alarmSensorsHubTooOld,
  alarmSwitchOutcome,
  alarmSwitchPatch,
  beginAlarmSwitch,
} from './alarm-sensor-table-model'
import { usePickerSiteZones } from './device-picker-grouping'
import type { PickerDevice } from './device-picker-model'
import { deviceListStateOf } from './device-selection'
import {
  alarmIsActive,
  alarmModeLabel,
  alarmPollIntervalMs,
  blockingFor,
  modeDelayEdit,
  modePostTriggeredEdit,
  modeNotifyEdit,
  modeScheduleEdit,
  nonBlockingFor,
  secureOnArmOffFor,
} from './notification-alarm.helpers'
import { useTranslation } from 'react-i18next'

const ALARM_QUERY_KEY = ['notificationRules', 'getAlarmConfig'] as const
const SENSORS_QUERY_KEY = ['notificationRules', 'getAlarmSensors'] as const
const OPENINGS_QUERY_KEY = ['deviceManager', 'listDeviceIdsByCaps', 'alarm-openings'] as const
/** Bindings change on an operator action, not on a poll. */
const OPENINGS_STALE_MS = 60_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What the page says about the switch write it just made, or refused to make. */
type SwitchNotice =
  | { readonly kind: 'refused'; readonly inFlight: AlarmSwitchWrite }
  | { readonly kind: 'not-landed'; readonly write: AlarmSwitchWrite }
  | { readonly kind: 'failed'; readonly write: AlarmSwitchWrite; readonly error: string }

interface SwitchNoticeLineProps {
  readonly notice: SwitchNotice
}

function SwitchNoticeLine({ notice }: SwitchNoticeLineProps) {
  const { t } = useTranslation()
  switch (notice.kind) {
    case 'refused':
      return (
        <p className="text-xs text-warning" role="alert" data-testid="alarm-switch-refused">
          {t('system.notificationAlarm.refused', {
            name: notice.inFlight.name,
            mode: alarmModeLabel(notice.inFlight.mode),
          })}
        </p>
      )
    case 'not-landed':
      return (
        <p className="text-xs text-warning" role="alert" data-testid="alarm-switch-not-landed">
          {t('system.notificationAlarm.notLanded', {
            name: notice.write.name,
            mode: alarmModeLabel(notice.write.mode),
          })}
        </p>
      )
    case 'failed':
      return (
        <p className="text-xs text-danger" role="alert" data-testid="alarm-switch-failed">
          {t(
            'system.notificationAlarm.couldNotChangeFor',
            'Could not change {{name}} for {{value2}}: {{error}}',
            {
              name: notice.write.name,
              value2: alarmModeLabel(notice.write.mode),
              error: notice.error,
            },
          )}
        </p>
      )
  }
}

export function NotificationAlarmPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()

  const configQuery = useQuery({
    queryKey: ALARM_QUERY_KEY,
    queryFn: async (): Promise<NcAlarmConfig> =>
      system.trpcClient.notificationRules.getAlarmConfig.query({}),
    // Fast while something is counting down (exit delay, entry delay, siren),
    // slow otherwise — a countdown shown 15 s late looks stuck.
    refetchInterval: (query) => alarmPollIntervalMs(query.state.data?.live?.state),
  })

  // The shared fleet query. `slim` was already right here; what was wrong was
  // the CLIENT — a raw `trpcClient` call under the private key
  // `['deviceManager','listAll','alarm-coverage']`, which the D274 window
  // (registered on the tRPC key prefix) and the `[['deviceManager']]`
  // invalidations both miss. Every device, not just cameras: an alarm panel
  // covers locks and sirens. Reads `id` and `name` only.
  const devicesQuery = useDeviceManagerListAll({ projection: 'slim' })

  // True when the last patch came back WITHOUT its change: a host older than this build strips
  // the keys it does not know, and another editor may have changed the field since.
  const [saveNotLanded, setSaveNotLanded] = useState(false)
  const save = useMutation({
    mutationFn: (patch: NcAlarmSettingsPatch) =>
      system.trpcClient.notificationRules.setAlarmConfig.mutate({ patch }),
    // The answer is the whole config as the hub settled it — render THAT,
    // never the input — and check that what was sent is in it.
    onSuccess: (next: NcAlarmConfig, sent: NcAlarmSettingsPatch) => {
      queryClient.setQueryData(ALARM_QUERY_KEY, next)
      setSaveNotLanded(!alarmPatchLanded(sent, next.settings))
    },
  })

  const profileMutate = useMutation({
    mutationFn: async (
      op:
        | { readonly kind: 'activate'; readonly id: string }
        | { readonly kind: 'create'; readonly name: string }
        | { readonly kind: 'clone'; readonly fromId: string; readonly name: string }
        | { readonly kind: 'rename'; readonly id: string; readonly name: string }
        | { readonly kind: 'delete'; readonly id: string },
    ): Promise<NcAlarmConfig> => {
      switch (op.kind) {
        case 'activate':
          return system.trpcClient.notificationRules.activateAlarmProfile.mutate({ id: op.id })
        case 'create':
          return system.trpcClient.notificationRules.createAlarmProfile.mutate({ name: op.name })
        case 'clone':
          return system.trpcClient.notificationRules.createAlarmProfile.mutate({
            name: op.name,
            cloneFromId: op.fromId,
          })
        case 'rename':
          return system.trpcClient.notificationRules.renameAlarmProfile.mutate({
            id: op.id,
            name: op.name,
          })
        case 'delete':
          return system.trpcClient.notificationRules.deleteAlarmProfile.mutate({ id: op.id })
      }
    },
    onSuccess: (next: NcAlarmConfig) => {
      queryClient.setQueryData(ALARM_QUERY_KEY, next)
      setSaveNotLanded(false)
    },
  })

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ALARM_QUERY_KEY })

  const deviceNames = useMemo(() => {
    const m = new Map<number, string>()
    for (const d of devicesQuery.data ?? []) m.set(d.id, d.name)
    return m
  }, [devicesQuery.data])

  const live = configQuery.data?.live
  // EVERY opening of the household (D636), not only the covered ones: ONE
  // targeted, ids-only read. Independent of the fleet listing (which only
  // names them), so a failed fleet cannot leave this "checking" forever.
  const openingsQuery = useQuery({
    queryKey: OPENINGS_QUERY_KEY,
    staleTime: OPENINGS_STALE_MS,
    queryFn: async (): Promise<ReadonlySet<number>> =>
      new Set(
        await system.trpcClient.deviceManager.listDeviceIdsByCaps.query({
          capNames: [...ALARM_OPENING_CAP_NAMES],
        }),
      ),
  })
  // The devices the pickers list: an opening's type and room group it.
  const pickable = useMemo((): readonly PickerDevice[] => {
    const rows = devicesQuery.data ?? []
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      type: String(d.type),
      location: d.location ?? null,
    }))
  }, [devicesQuery.data])
  const fleetById = useMemo(() => new Map(pickable.map((d) => [d.id, d])), [pickable])
  const openingsCheck: AlarmOpeningsCheck = openingsQuery.isError
    ? {
        status: 'failed',
        error:
          openingsQuery.error instanceof Error
            ? openingsQuery.error.message
            : String(openingsQuery.error),
        retry: () => void openingsQuery.refetch(),
      }
    : openingsQuery.data !== undefined
      ? { status: 'answered', openingIds: openingsQuery.data }
      : { status: 'pending' }

  const names = useMemo(() => {
    // The name the hub read a device under wins: it answered for THAT device.
    const openNames = new Map<number, string>()
    for (const row of live?.openings ?? []) {
      for (const d of row.devices) openNames.set(d.deviceId, hubDeviceName(d))
    }
    return alarmDeviceNames(deviceNames, deviceListStateOf(devicesQuery), openNames)
  }, [live, deviceNames, devicesQuery])

  const zones = usePickerSiteZones(true)
  // The selected mode tab; null until the operator picks one (then the first mode is shown).
  const [modeTab, setModeTab] = useState<AlarmArmMode | null>(null)

  // Every mode's candidate openings (D636: every opening of the household plus
  // every id already listed, D49). A removed id is a row but is never read.
  const candidatesByMode = useMemo((): ReadonlyMap<AlarmArmMode, readonly number[]> => {
    const byMode = new Map<AlarmArmMode, readonly number[]>()
    const data = configQuery.data
    if (data === undefined) return byMode
    for (const coverage of data.coverage) {
      byMode.set(
        coverage.mode,
        nonBlockingOptions({
          live: data.live,
          listed: nonBlockingFor(data.settings, coverage.mode),
          openingIds: openingsQuery.data ?? null,
        }).ids,
      )
    }
    return byMode
  }, [configQuery.data, openingsQuery.data])
  const sensorIds = useMemo((): readonly number[] => {
    const all = new Set<number>()
    for (const ids of candidatesByMode.values()) {
      for (const id of ids) if (!names.isRemoved(id)) all.add(id)
    }
    return [...all].toSorted((a, b) => a - b)
  }, [candidatesByMode, names])

  const sensorsQuery = useQuery({
    queryKey: [...SENSORS_QUERY_KEY, sensorIds],
    enabled: sensorIds.length > 0,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    // An older hub is answered by NAME and will not learn the method by being
    // asked again — stop polling it (the page then says so, once).
    refetchInterval: (query) =>
      query.state.error !== null && alarmSensorsHubTooOld(errorText(query.state.error))
        ? false
        : live !== undefined && alarmIsActive(live.state)
          ? 5_000
          : 15_000,
    retry: (failures, error) => !alarmSensorsHubTooOld(errorText(error)) && failures < 2,
    queryFn: async (): Promise<NcAlarmSensors> => {
      const answers: NcAlarmSensors[] = []
      // In SEQUENCE: any chunk failing fails the read, said once.
      for (const chunk of alarmSensorReadChunks(sensorIds, NC_ALARM_SENSORS_MAX)) {
        answers.push(
          await system.trpcClient.notificationRules.getAlarmSensors.query({
            deviceIds: [...chunk],
          }),
        )
      }
      return {
        sensors: answers.flatMap((a) => a.sensors),
        // The oldest chunk bounds how fresh the whole read is.
        readAt: Math.min(...answers.map((a) => a.readAt)),
      }
    },
  })
  const sensorsRead: AlarmSensorsRead = sensorsQuery.isError
    ? { status: 'failed', error: errorText(sensorsQuery.error) }
    : sensorsQuery.data !== undefined
      ? { status: 'answered', sensors: sensorsQuery.data.sensors }
      : { status: 'pending' }

  // The write gate is the REF: two presses in one tick must not both start.
  const inFlightRef = useRef<AlarmSwitchWrite | null>(null)
  const [inFlight, setInFlight] = useState<AlarmSwitchWrite | null>(null)
  const [notice, setNotice] = useState<SwitchNotice | null>(null)

  const runSwitchWrite = async (write: AlarmSwitchWrite): Promise<void> => {
    try {
      const answer = await system.trpcClient.notificationRules.setAlarmConfig.mutate({
        patch: alarmSwitchPatch(write),
      })
      if (alarmSwitchOutcome(write, answer.settings).kind === 'landed') {
        queryClient.setQueryData(ALARM_QUERY_KEY, answer)
      } else {
        setNotice({ kind: 'not-landed', write })
        void queryClient.invalidateQueries({ queryKey: ALARM_QUERY_KEY })
      }
    } catch (err) {
      setNotice({ kind: 'failed', write, error: errorText(err) })
      void queryClient.invalidateQueries({ queryKey: ALARM_QUERY_KEY })
    } finally {
      inFlightRef.current = null
      setInFlight(null)
      // "Wait for it to finish" is stale the moment it has finished.
      setNotice((current) => (current?.kind === 'refused' ? null : current))
    }
  }

  const onSwitch = (
    mode: AlarmArmMode,
    row: AlarmSensorRow,
    switchKind: 'blocks' | 'secureOnArm',
    nextValue: boolean,
  ): void => {
    const begin = beginAlarmSwitch(inFlightRef.current, mode, row, switchKind, nextValue)
    if (begin.kind === 'refused') {
      setNotice({ kind: 'refused', inFlight: begin.inFlight })
      return
    }
    inFlightRef.current = begin.write
    setInFlight(begin.write)
    setNotice(null)
    void runSwitchWrite(begin.write)
  }

  if (configQuery.isLoading) {
    return (
      <AdminPage
        embedded
        icon={ShieldCheck}
        title={t('system.notificationAlarm.alarm', 'Alarm')}
        subtitle={t(
          'system.notificationAlarm.panelDelaysAndModeCoverage',
          'Panel delays and mode coverage.',
        )}
      >
        <Loader2 className="h-5 w-5 animate-spin" />
      </AdminPage>
    )
  }

  const config = configQuery.data
  if (config === undefined || configQuery.isError) {
    return (
      <AdminPage
        embedded
        icon={ShieldCheck}
        title={t('system.notificationAlarm.alarm', 'Alarm')}
        subtitle={t(
          'system.notificationAlarm.panelDelaysAndModeCoverage',
          'Panel delays and mode coverage.',
        )}
      >
        <ErrorBox
          title={t(
            'system.notificationAlarm.alarmSettingsAreNotAvailable',
            'Alarm settings are not available',
          )}
          message={t(
            'system.notificationAlarm.thisHubHasNotBeen',
            'This hub has not been updated to serve the alarm configuration yet.',
          )}
        />
      </AdminPage>
    )
  }

  // NO panel is a statement, not an empty form. The hub owns the one panel; on
  // any other node an editor here would save nothing.
  if (config.deviceId === null) {
    return (
      <AdminPage
        embedded
        icon={ShieldCheck}
        title={t('system.notificationAlarm.alarm', 'Alarm')}
        subtitle={t(
          'system.notificationAlarm.panelDelaysAndModeCoverage',
          'Panel delays and mode coverage.',
        )}
      >
        <Card className="p-4">
          <p className="text-sm text-foreground-subtle">
            {t(
              'system.notificationAlarm.thisInstallationHasNoAlarm',
              'This installation has no alarm panel. The panel is created by the Notification Center on the hub — if this is the hub, its creation failed and the server log says why.',
            )}
          </p>
        </Card>
      </AdminPage>
    )
  }

  const settings = config.settings
  const busy = save.isPending || profileMutate.isPending

  // The ONE way a settings patch leaves this page (recipients, per-mode delays).
  const patch = (next: NcAlarmSettingsPatch): void => {
    setSaveNotLanded(false)
    save.mutate(next)
  }

  const editModeDelay = (
    mode: AlarmArmMode,
    field: NcAlarmDelayField,
    next: number | 'default',
  ): void => {
    const edit = modeDelayEdit(settings, mode, field, next)
    if (edit !== null) patch({ modeDelays: [edit] })
  }

  const editModePostTriggered = (
    mode: AlarmArmMode,
    next: NcAlarmPostTriggeredAction | 'default',
  ): void => {
    const edit = modePostTriggeredEdit(settings, mode, next)
    if (edit !== null) patch({ modeDelays: [edit] })
  }

  const editModeSchedule = (mode: AlarmArmMode, next: NcSchedule | undefined): void => {
    const edit = modeScheduleEdit(settings, mode, next)
    if (edit !== null) patch({ modeDelays: [edit] })
  }

  const editModeNotify = (mode: AlarmArmMode, field: NcAlarmNotifyField, next: boolean): void => {
    const edit = modeNotifyEdit(settings, mode, field, next)
    if (edit !== null) patch({ modeDelays: [edit] })
  }

  // Every mode's rows, once: the tab counts and the selected tab read the same list.
  const rowsByMode = new Map<AlarmArmMode, readonly AlarmSensorRow[]>(
    config.coverage.map((row) => [
      row.mode,
      alarmSensorRows({
        candidates: (candidatesByMode.get(row.mode) ?? []).map(
          (id): PickerDevice => ({ ...fleetById.get(id), id, name: names.nameOf(id) }),
        ),
        removedIds: new Set((candidatesByMode.get(row.mode) ?? []).filter(names.isRemoved)),
        coverage: row,
        nonBlocking: nonBlockingFor(settings, row.mode),
        blocking: blockingFor(settings, row.mode),
        secureOnArmOff: secureOnArmOffFor(settings, row.mode),
        sensors: sensorsRead,
      }),
    ]),
  )
  // Until the operator picks a tab: the first mode that checks a sensor, else the first mode.
  const activeCoverage =
    config.coverage.find((c) => c.mode === modeTab) ??
    config.coverage.find((c) => (rowsByMode.get(c.mode)?.length ?? 0) > 0) ??
    config.coverage[0]
  const activeMode = activeCoverage?.mode ?? ''

  return (
    <AdminPage
      embedded
      icon={ShieldCheck}
      title={t('system.notificationAlarm.alarm', 'Alarm')}
      subtitle={t(
        'system.notificationAlarm.thePanelWhatEachMode',
        'The panel, what each mode arms, and who hears about it.',
      )}
    >
      {save.isError ? (
        <ErrorBox
          title={t('system.notificationAlarm.couldNotSave', 'Could not save')}
          message={String(save.error)}
        />
      ) : null}
      {profileMutate.isError ? (
        <ErrorBox
          title={t('system.notificationAlarm.couldNotUpdateProfile', 'Could not update profile')}
          message={String(profileMutate.error)}
        />
      ) : null}
      {saveNotLanded ? (
        <div data-testid="alarm-save-not-landed">
          <ErrorBox
            variant="warning"
            title={t('system.notificationAlarm.notApplied', 'Not applied')}
            message={t(
              'system.notificationAlarm.theHubDidNotApply',
              'The hub did not apply this change — another editor may have changed it, or the hub needs an update',
            )}
          />
        </div>
      ) : null}

      {config.profiles !== undefined ? (
        <AlarmProfileBar
          profiles={config.profiles}
          busy={busy}
          onActivate={(id) => profileMutate.mutate({ kind: 'activate', id })}
          onCreate={(name) => profileMutate.mutate({ kind: 'create', name })}
          onClone={(fromId, name) => profileMutate.mutate({ kind: 'clone', fromId, name })}
          onRename={(id, name) => profileMutate.mutate({ kind: 'rename', id, name })}
          onDelete={(id) => profileMutate.mutate({ kind: 'delete', id })}
        />
      ) : null}

      <AlarmLiveCard live={config.live} onChanged={refresh} />

      <Card className="p-4" data-testid="alarm-coverage">
        <Tabs
          value={activeMode}
          onValueChange={(next) => {
            const picked = config.coverage.find((c) => c.mode === next)
            if (picked !== undefined) setModeTab(picked.mode)
          }}
        >
          <TabsList className="mb-3">
            {config.coverage.map((row) => (
              <TabsTrigger key={row.mode} value={row.mode} data-testid={`alarm-tab-${row.mode}`}>
                {alarmModeLabel(row.mode)}
                <span className="ml-1.5 text-[10px] text-foreground-subtle">
                  {rowsByMode.get(row.mode)?.length ?? 0}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {notice !== null ? <SwitchNoticeLine notice={notice} /> : null}
        {activeCoverage === undefined ? null : (
          <AlarmModeCard
            key={activeCoverage.mode}
            coverage={activeCoverage}
            live={config.live}
            settings={settings}
            names={names}
            openingsCheck={openingsCheck}
            rows={rowsByMode.get(activeCoverage.mode) ?? []}
            sensorsRetry={
              sensorsRead.status === 'failed' && !alarmSensorsHubTooOld(sensorsRead.error)
                ? () => void sensorsQuery.refetch()
                : null
            }
            inFlight={inFlight}
            onSwitch={(r, kind, next) => onSwitch(activeCoverage.mode, r, kind, next)}
            zones={zones}
            onDelayEdit={(field, next) => editModeDelay(activeCoverage.mode, field, next)}
            onPostTriggeredEdit={(next) => editModePostTriggered(activeCoverage.mode, next)}
            onScheduleEdit={(next) => editModeSchedule(activeCoverage.mode, next)}
            onNotifyEdit={(field, next) => editModeNotify(activeCoverage.mode, field, next)}
            disabled={busy}
          />
        )}
      </Card>
    </AdminPage>
  )
}

export default NotificationAlarmPage
