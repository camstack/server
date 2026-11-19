/**
 * Diagnostics — armed windows and log channels, each with the deadline it
 * expires at.
 *
 * A diagnostic left on is itself an incident, and the only way to notice one
 * is a page that lists it with the time it has left. So every row states the
 * deadline in plain words ("expires in 4m 12s"), not a boolean.
 *
 * Arming goes through `system.setLoggingSettings` — the ONE write authority
 * over the window. `system.setRequestCensus` was retired on 2026-08-27 (D245)
 * precisely so this page and some other caller cannot disagree about the same
 * window. `system.getRequestCensus` still exists and is a different thing: it
 * returns what the census MEASURED, which is a result, not a setting.
 *
 * ## The channel list
 *
 * ONE list of the log channels the cluster's addons DECLARE, grouped by addon.
 * The roster is not written here — it arrives through `log-channels`, so a
 * channel added by a redeployed addon appears without anybody editing this
 * file. A `diagnostic` channel arms a window; a `debug` channel is WATCHED
 * (`system.debugWatch`): a 10 minute window that this page re-arms every 4
 * minutes while it stays open. Closing the page stops the re-arms and the
 * watch lapses by itself; past a hard cap of 60 minutes it lapses regardless,
 * and a lapsed watch is never revived by the page — Start is always an
 * operator's decision.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Activity, Loader2, TimerReset } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  LogStream,
  SectionCard,
  useSystemDebugWatch,
  useSystemGetLoggingSettings,
  useSystemSetLoggingSettings,
} from '@camstack/ui-library'
import {
  DEBUG_WATCH_REARM_EVERY_MS,
  type DebugWatchState,
  type DiagnosticWindow,
} from '@camstack/types'
import { AdminPage } from '../../components/AdminPage'
import { ARM_BUTTON, ARM_CHOICES_MS, LogChannelRow } from './LogChannelRow'
import { channelsToRearm, formatRemaining, groupChannelsByAddon } from './log-watch.helpers'

const CLOCK_MS = 1_000
const LIST_EVERY_MS = 15_000

export function LogDiagnosticsPage(): ReactElement {
  const { t } = useTranslation()
  const settings = useSystemGetLoggingSettings({}, { refetchInterval: 5_000 })
  const write = useSystemSetLoggingSettings()
  const watch = useSystemDebugWatch()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [watches, setWatches] = useState<readonly DebugWatchState[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [lapsedNotice, setLapsedNotice] = useState<readonly string[]>([])
  const [nowMs, setNowMs] = useState<number>(() => Date.now())

  const arm = (id: DiagnosticWindow['id'], armMs: number): void => {
    setPendingId(id)
    write.mutate(
      { patch: { diagnostics: [{ id, armMs }] } },
      {
        onSettled: () => {
          setPendingId(null)
          void settings.refetch()
        },
      },
    )
  }

  /**
   * `deviceIds: null` = every camera. An EMPTY list would be a window that
   * matches nothing, which reads exactly like a disarmed one — so the picker
   * collapses to `null` rather than to `[]`.
   */
  const armChannel = (
    channel: string,
    armMs: number,
    deviceIds: readonly number[] | null,
  ): void => {
    setPendingId(channel)
    write.mutate(
      { patch: { channels: [{ channel, armMs, deviceIds }] } },
      {
        onSettled: () => {
          setPendingId(null)
          void settings.refetch()
        },
      },
    )
  }

  const call = useCallback(
    (
      action: 'list' | 'start' | 'rearm' | 'stop',
      names: readonly string[],
      ids: readonly number[],
    ) => {
      watch.mutate(
        { action, channels: names, deviceIds: ids },
        {
          onSuccess: (result) => {
            setWatches(result.watches)
            setLapsedNotice(result.lapsed)
          },
        },
      )
    },
    // `mutate` is stable; the mutation object is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // One clock for the countdown, one poll for what the hub holds, one re-arm.
  useEffect(() => {
    const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS)
    return () => clearInterval(clock)
  }, [])
  useEffect(() => {
    call('list', [], [])
    const poll = setInterval(() => call('list', [], []), LIST_EVERY_MS)
    return () => clearInterval(poll)
  }, [call])
  const rearming = channelsToRearm(watches, selected).join('|')
  useEffect(() => {
    if (rearming === '') return undefined
    const rearm = setInterval(
      () => call('rearm', rearming.split('|'), []),
      DEBUG_WATCH_REARM_EVERY_MS,
    )
    return () => clearInterval(rearm)
  }, [rearming, call])

  const startWatch = (channel: string, deviceIds: readonly number[]): void => {
    setSelected((prev) => (prev.includes(channel) ? prev : [...prev, channel]))
    call('start', [channel], deviceIds)
  }
  const stopWatch = (channel: string): void => {
    setSelected((prev) => prev.filter((name) => name !== channel))
    call('stop', [channel], [])
  }

  const windows = settings.data?.activeWindows ?? []
  const activeChannels = settings.data?.activeChannels ?? []
  const groups = useMemo(() => groupChannelsByAddon(settings.data?.channels ?? []), [settings.data])
  const watchedDevices = [...new Set(watches.flatMap((w) => w.deviceIds))]

  return (
    <AdminPage
      embedded
      icon={Activity}
      title={t('logging.diagnostics.title', 'Diagnostics')}
      subtitle={t(
        'logging.diagnostics.subtitle',
        'Windows and channels are armed for a limited time, never switched on. Each carries a deadline and expires by itself — one left running is an incident of its own.',
      )}
    >
      {settings.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface divide-y divide-border">
          {windows.map((window) => (
            <WindowRow
              key={window.id}
              window={window}
              busy={pendingId === window.id}
              onArm={(ms) => arm(window.id, ms)}
            />
          ))}
        </div>
      )}

      <h3 className="mt-6 text-sm font-medium text-foreground">
        {t('logging.diagnostics.channels', 'Log channels')}
      </h3>
      <p className="mb-2 max-w-3xl text-[11px] text-foreground-subtle">
        {t(
          'logging.diagnostics.channelsSubtitle',
          'Declared by the addons that own them, grouped by addon. A diagnostic channel opens a window with a deadline; a debug channel starts a live watch that this page keeps renewed while it stays open.',
        )}
      </p>
      {groups.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'logging.diagnostics.noChannels',
            'No addon on this cluster declares a log channel, or none could be reached right now.',
          )}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.addon} aria-label={group.addon}>
              <h4 className="mb-1 text-xs font-medium text-foreground-muted">{group.addon}</h4>
              <div className="rounded-lg border border-border bg-surface divide-y divide-border">
                {group.channels.map((channel) => (
                  <LogChannelRow
                    key={channel.name}
                    channel={channel}
                    armed={activeChannels.find((w) => w.channel === channel.name)}
                    watch={watches.find((w) => w.channel === channel.name)}
                    nowMs={nowMs}
                    busy={pendingId === channel.name || watch.isPending}
                    onArm={(ms, deviceIds) => armChannel(channel.name, ms, deviceIds)}
                    onStartWatch={(deviceIds) => startWatch(channel.name, deviceIds)}
                    onStopWatch={() => stopWatch(channel.name)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {watch.isError && <p className="mt-2 text-[11px] text-danger">{watch.error.message}</p>}
      {lapsedNotice.length > 0 && (
        <p className="mt-2 text-[11px] text-warning">
          {t(
            'logging.diagnostics.lapsed',
            'Already ended, not renewed: {{names}}. Start again to continue.',
            { names: lapsedNotice.join(', ') },
          )}
        </p>
      )}

      {watchedDevices.length > 0 && (
        <SectionCard headingId="log-diagnostics-live" title={t('logging.diagnostics.live', 'Live')}>
          {watchedDevices.map((id) => (
            <div key={id} className="border-t border-border first:border-t-0">
              <LogStream
                deviceId={id}
                limit={200}
                maxHeight="max-h-80"
                showScope
                showFilters={false}
              />
            </div>
          ))}
        </SectionCard>
      )}
    </AdminPage>
  )
}

function WindowRow({
  window,
  busy,
  onArm,
}: {
  readonly window: DiagnosticWindow
  readonly busy: boolean
  readonly onArm: (armMs: number) => void
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{window.id}</span>
          {window.armed ? (
            <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
              <TimerReset className="h-3 w-3" />
              {t('logging.diagnostics.expiresIn', 'expires in {{left}}', {
                left: formatRemaining(window.remainingMs),
              })}
            </span>
          ) : (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-subtle">
              {t('logging.diagnostics.disarmed', 'disarmed')}
            </span>
          )}
          {window.armed && !window.persisted && (
            <span className="text-[10px] text-warning">
              {t('logging.diagnostics.notPersisted', 'not persisted — will not survive a restart')}
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-2xl text-[11px] text-foreground-subtle">
          {t(`logging.diagnostics.caption.${window.id}`, { defaultValue: '' })}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {ARM_CHOICES_MS.map((ms) => (
          <Button
            variant="unstyled"
            key={ms}
            type="button"
            disabled={busy}
            onClick={() => onArm(ms)}
            className={ARM_BUTTON}
          >
            {formatRemaining(ms)}
          </Button>
        ))}
        <Button
          variant="unstyled"
          type="button"
          disabled={busy || !window.armed}
          onClick={() => onArm(0)}
          className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
        >
          {t('logging.diagnostics.disarm', 'Disarm')}
        </Button>
      </div>
    </div>
  )
}
