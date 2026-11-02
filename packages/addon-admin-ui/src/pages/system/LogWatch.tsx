/**
 * Logs → Watch — switch a debug channel on for chosen devices for a short
 * window and read it live.
 *
 * A watch is a 10 minute window. While this page stays open it re-arms every
 * 4 minutes; closing the page stops the re-arms and the watch lapses by
 * itself. Past a hard cap of 60 minutes from the first start it lapses
 * regardless, and a lapsed watch is never revived by the page — Start is
 * always an operator's decision. Between watches the debug lines cost nothing:
 * the code that builds them does not run and the log ring does not keep them.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Eye, Loader2, Square, TimerReset } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  DeviceMultiSelectField,
  LogStream,
  SectionCard,
  useSystemDebugWatch,
  useSystemGetLoggingSettings,
} from '@camstack/ui-library'
import {
  DEBUG_WATCH_REARM_EVERY_MS,
  type ConfigDeviceMultiSelectField,
  type DebugWatchState,
} from '@camstack/types'
import { AdminPage } from '../../components/AdminPage'
import {
  channelsToRearm,
  formatRemaining,
  parseDeviceIds,
  watchCountdown,
} from './log-watch.helpers'

const DEVICE_FIELD: Omit<ConfigDeviceMultiSelectField, 'label'> = {
  type: 'device-multiselect',
  key: 'watch-devices',
  deviceFilter: { types: ['camera'] },
  maxItems: 8,
}

const CLOCK_MS = 1_000
const LIST_EVERY_MS = 15_000

export function LogWatchPage(): ReactElement {
  const { t } = useTranslation()
  const settings = useSystemGetLoggingSettings({}, { refetchInterval: 15_000 })
  const watch = useSystemDebugWatch()
  const [watches, setWatches] = useState<readonly DebugWatchState[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [devices, setDevices] = useState<readonly string[]>([])
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const [lapsedNotice, setLapsedNotice] = useState<readonly string[]>([])

  const channels = useMemo(
    () => (settings.data?.channels ?? []).filter((c) => c.kind === 'debug'),
    [settings.data],
  )

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

  const deviceIds = parseDeviceIds(devices)
  const canStart = selected.length > 0 && deviceIds.length > 0 && !watch.isPending
  const watchedDevices = [...new Set(watches.flatMap((w) => w.deviceIds))]

  const toggle = (name: string, on: boolean): void =>
    setSelected((prev) => (on ? [...prev, name] : prev.filter((n) => n !== name)))

  return (
    <AdminPage
      embedded
      icon={Eye}
      title={t('logging.watch.title', 'Watch')}
      subtitle={t(
        'logging.watch.subtitle',
        'Switch a debug channel on for chosen devices and read it live. A watch lasts 10 minutes, is renewed while this page stays open, and ends by itself after 60 minutes at most.',
      )}
    >
      <SectionCard
        headingId="log-watch-setup"
        title={t('logging.watch.setup', 'Channels and devices')}
      >
        {settings.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : channels.length === 0 ? (
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'logging.watch.noChannels',
              'No addon on this cluster offers a debug channel, or none could be reached right now.',
            )}
          </p>
        ) : (
          <div className="space-y-3 p-3">
            <div className="space-y-2">
              {channels.map((channel) => (
                <label key={channel.name} className="flex items-start gap-2">
                  <Checkbox
                    checked={selected.includes(channel.name)}
                    onChange={(e) => toggle(channel.name, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium text-foreground">{channel.name}</span>
                    <span className="block text-[11px] text-foreground-subtle">
                      {channel.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <DeviceMultiSelectField
              field={{ ...DEVICE_FIELD, label: t('logging.watch.devices', 'Devices') }}
              value={devices}
              onChange={(next) =>
                setDevices(Array.isArray(next) ? next.filter((v) => typeof v === 'string') : [])
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!canStart}
                onClick={() => call('start', selected, deviceIds)}
              >
                {t('logging.watch.start', 'Start watching')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={watches.length === 0 || watch.isPending}
                onClick={() =>
                  call(
                    'stop',
                    watches.map((w) => w.channel),
                    [],
                  )
                }
              >
                <Square className="mr-1 h-3.5 w-3.5" />
                {t('logging.watch.stop', 'Stop')}
              </Button>
            </div>
            {watch.isError && <p className="text-[11px] text-destructive">{watch.error.message}</p>}
            {lapsedNotice.length > 0 && (
              <p className="text-[11px] text-warning">
                {t(
                  'logging.watch.lapsed',
                  'Already ended, not renewed: {{names}}. Start again to continue.',
                  {
                    names: lapsedNotice.join(', '),
                  },
                )}
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {watches.length > 0 && (
        <SectionCard headingId="log-watch-live" title={t('logging.watch.live', 'Live')}>
          <div className="divide-y divide-border">
            {watches.map((w) => {
              const left = watchCountdown(w, nowMs)
              return (
                <div key={w.channel} className="flex flex-wrap items-center gap-2 p-3">
                  <span className="text-sm font-medium text-foreground">{w.channel}</span>
                  <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                    <TimerReset className="h-3 w-3" />
                    {t('logging.watch.endsIn', 'ends in {{left}}', {
                      left: formatRemaining(left.windowMs),
                    })}
                  </span>
                  <span className="text-[11px] text-foreground-subtle">
                    {t('logging.watch.capIn', 'hard stop in {{left}}', {
                      left: formatRemaining(left.capMs),
                    })}
                  </span>
                  <span className="text-[11px] text-foreground-subtle">
                    #{w.deviceIds.join(', #')}
                  </span>
                </div>
              )
            })}
          </div>
          {watchedDevices.map((id) => (
            <div key={id} className="border-t border-border">
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
