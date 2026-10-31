/**
 * Diagnostics — the armed windows, each with the deadline it expires at.
 *
 * A diagnostic left on is itself an incident, and the only way to notice one
 * is a page that lists it with the time it has left. So every row here states
 * the deadline in plain words ("expires in 4m 12s"), not a boolean.
 *
 * Arming goes through `system.setLoggingSettings` — the ONE write authority
 * over the window. `system.setRequestCensus` was retired on 2026-08-27 (D245)
 * precisely so this page and some other caller cannot disagree about the same
 * window. `system.getRequestCensus` still exists and is a different thing: it
 * returns what the census MEASURED, which is a result, not a setting.
 *
 * ## The channel rows
 *
 * The second section lists the per-component CHANNELS the cluster's addons
 * DECLARE. The roster is not written here — it arrives from the addons through
 * `log-channels`, so a channel added by a redeployed addon appears without
 * anybody editing this file, and one whose addon is gone stops being offered.
 * A hand-maintained list would rot at the first addition, silently.
 *
 * A channel declared `perDevice: false` says so on its row and offers no
 * camera box. Its lines carry the device in `meta` rather than in
 * `tags: { deviceId }`, so `| json | deviceId="102"` would select none of
 * them — and an operator who narrowed and saw nothing would conclude the code
 * path was never taken. The server refuses such a patch too; the UI simply
 * does not offer the lie in the first place.
 */
import { useState, type ReactElement } from 'react'
import { Activity, Camera, Loader2, TimerReset } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useSystemGetLoggingSettings,
  useSystemSetLoggingSettings,
  Button,
  Input,
} from '@camstack/ui-library'
import type { DiagnosticWindow, LogChannelDescriptor, LogChannelWindowState } from '@camstack/types'
import { AdminPage } from '../../components/AdminPage'

/** Offered windows. The server clamps; these are the useful shapes. */
const ARM_CHOICES_MS: readonly number[] = [120_000, 300_000, 600_000, 1_800_000]

/** One line per diagnostic saying what arming it buys. */
const DIAGNOSTIC_CAPTIONS: Readonly<Record<string, string>> = {
  'request-census':
    'Counts every tRPC call by TRANSPORT PLANE — http, ws, mesh — and by procedure, caller, address and user-agent. Subscriptions are counted apart from calls, so a long-lived stream cannot pass for a storm. Arm it, then restart: the deadline is persisted, so the window is still running when clients reconnect.',
}

export function LogDiagnosticsPage(): ReactElement {
  const { t } = useTranslation()
  const settings = useSystemGetLoggingSettings({}, { refetchInterval: 5_000 })
  const write = useSystemSetLoggingSettings()
  const [pendingId, setPendingId] = useState<string | null>(null)

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

  const windows = settings.data?.activeWindows ?? []
  const channels = settings.data?.channels ?? []
  const activeChannels = settings.data?.activeChannels ?? []

  /**
   * `deviceIds: null` = every camera. An EMPTY list would be a window that
   * matches nothing, which reads exactly like a disarmed one — so the parsed
   * box collapses to `null` rather than to `[]`.
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

  return (
    <AdminPage
      embedded
      icon={Activity}
      title={t('logging.diagnostics.title', 'Diagnostics')}
      subtitle={t(
        'logging.diagnostics.subtitle',
        'Diagnostics are armed for a window, never switched on. Each carries a deadline and expires by itself — one left running is an incident of its own.',
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
        {t('logging.diagnostics.channels', 'Component channels')}
      </h3>
      <p className="mb-2 max-w-3xl text-[11px] text-foreground-subtle">
        {t(
          'logging.diagnostics.channelsSubtitle',
          'Declared by the addons that own them — this list is not maintained by hand. Arming a channel opens a window with a deadline; it closes by itself.',
        )}
      </p>
      {channels.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'logging.diagnostics.noChannels',
            'No addon on this cluster declares a log channel, or none could be reached right now.',
          )}
        </p>
      ) : (
        <div className="rounded-lg border border-border bg-surface divide-y divide-border">
          {channels.map((channel) => (
            <ChannelRow
              key={channel.name}
              channel={channel}
              state={activeChannels.find((w) => w.channel === channel.name)}
              busy={pendingId === channel.name}
              onArm={(ms, deviceIds) => armChannel(channel.name, ms, deviceIds)}
            />
          ))}
        </div>
      )}
    </AdminPage>
  )
}

/**
 * One declared channel, with its deadline and — only when the channel can
 * honestly honour it — a camera box.
 */
function ChannelRow({
  channel,
  state,
  busy,
  onArm,
}: {
  readonly channel: LogChannelDescriptor
  readonly state: LogChannelWindowState | undefined
  readonly busy: boolean
  readonly onArm: (armMs: number, deviceIds: readonly number[] | null) => void
}): ReactElement {
  const { t } = useTranslation()
  const [cameras, setCameras] = useState<string>('')
  const armed = state?.armed === true

  /** `102, 101` → `[102, 101]`; anything unparseable is dropped, empty → null. */
  const parseCameras = (): readonly number[] | null => {
    const ids = cameras
      .split(/[\s,+]+/)
      .filter((part) => /^\d+$/.test(part))
      .map((part) => Number(part))
    return ids.length > 0 ? ids : null
  }

  return (
    <div className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{channel.name}</span>
          {armed ? (
            <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
              <TimerReset className="h-3 w-3" />
              {t('logging.diagnostics.expiresIn', 'expires in {{left}}', {
                left: formatRemaining(state?.remainingMs ?? 0),
              })}
            </span>
          ) : (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-subtle">
              {t('logging.diagnostics.disarmed', 'disarmed')}
            </span>
          )}
          {armed && state?.deviceIds !== null && state?.deviceIds !== undefined && (
            <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <Camera className="h-3 w-3" />
              {state.deviceIds.join(', ')}
            </span>
          )}
          {!channel.perDevice && (
            // The corollary, stated where the operator would otherwise assume
            // the opposite: no camera box, and a reason for its absence.
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-subtle">
              {t('logging.diagnostics.notPerCamera', 'not filterable per camera')}
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-2xl text-[11px] text-foreground-subtle">{channel.description}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {channel.perDevice && (
          <Input
            type="text"
            inputMode="numeric"
            value={cameras}
            disabled={busy}
            onChange={(e) => setCameras(e.target.value)}
            placeholder={t('logging.diagnostics.camerasPlaceholder', 'all cameras')}
            className="w-28 rounded border border-border bg-surface px-2 py-1 text-[11px] text-foreground"
          />
        )}
        {ARM_CHOICES_MS.map((ms) => (
          <Button
            variant="unstyled"
            key={ms}
            type="button"
            disabled={busy}
            onClick={() => onArm(ms, parseCameras())}
            className="rounded border border-border px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground disabled:opacity-50"
          >
            {formatRemaining(ms)}
          </Button>
        ))}
        <Button
          variant="unstyled"
          type="button"
          disabled={busy || !armed}
          onClick={() => onArm(0, null)}
          className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
        >
          {t('logging.diagnostics.disarm', 'Disarm')}
        </Button>
      </div>
    </div>
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
          {DIAGNOSTIC_CAPTIONS[window.id] ?? ''}
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
            className="rounded border border-border px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground disabled:opacity-50"
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

/** `4m 12s`. Never a bare millisecond count — a deadline has to be readable. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  if (seconds === 0) return `${minutes}m`
  return `${minutes}m ${seconds}s`
}
