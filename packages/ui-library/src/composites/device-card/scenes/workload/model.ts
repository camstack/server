/**
 * The workload card's data (#585): a VM, an app container, an LXC, an app or
 * a host, drawn from the `workload` cap. What it can do comes from
 * `deriveWorkloadControls(getOptions, state)` and nothing else: an undeclared
 * action has no button. A value the provider did not report is `null` and is
 * not drawn (D393); `state: null` is unknown, never stopped (D315).
 */
import {
  DeviceRole,
  type WorkloadAction,
  type WorkloadControl,
  type WorkloadPort,
  type WorkloadResources,
  type WorkloadSections,
  type WorkloadState,
} from '@camstack/types'
import type { UiTextFn } from '../../../../contexts/ui-text'
import { MIN_PLAUSIBLE_TIMESTAMP_MS } from '../../../../lib/format-last-seen'
import { formatBytes } from '../../../cap-settings/recording-spans'
import type { CardGlyph } from '../../icons'
import type { RowStat } from '../../shell/bottom-rows'
import type { CardCommon, CardCommonActions, CardTone } from '../../shell/model'

/** The five kinds of workload; an unrecognised role is drawn as an app. */
export type WorkloadRole = 'vm' | 'app-container' | 'lxc' | 'app' | 'host'

export interface WorkloadHostLink {
  readonly deviceId: number
  readonly name: string | null
}

export interface WorkloadCardModel {
  readonly common: CardCommon
  readonly role: WorkloadRole
  readonly state: WorkloadState | null
  /** "3d 4h", how long it has been in this state (its uptime while it runs); null when not reported. */
  readonly uptime: string | null
  /** A command is in flight: every action waits for it to settle (D1061). */
  readonly busy: boolean
  readonly controls: readonly WorkloadControl[]
  readonly sections: WorkloadSections
  readonly resources: WorkloadResources
  readonly image: string | null
  readonly os: string | null
  readonly version: string | null
  readonly autostart: boolean | null
  readonly ports: readonly WorkloadPort[]
  readonly addresses: readonly string[]
  readonly updateAvailable: boolean | null
  /** The machine it runs on, when the provider names one. */
  readonly host: WorkloadHostLink | null
}

export interface WorkloadCardActions extends CardCommonActions {
  readonly onAction: (action: WorkloadAction) => void
  /** Opens another device (the host); absent where the host page offers no device view. */
  readonly onOpenDevice?: (deviceId: number) => void
}

const ROLES: Readonly<Record<string, WorkloadRole>> = {
  [DeviceRole.Vm]: 'vm',
  [DeviceRole.AppContainer]: 'app-container',
  [DeviceRole.Lxc]: 'lxc',
  [DeviceRole.App]: 'app',
  [DeviceRole.Host]: 'host',
}

export function workloadRoleOf(role: string | null | undefined): WorkloadRole {
  return (role === null || role === undefined ? undefined : ROLES[role]) ?? 'app'
}

export const WORKLOAD_ROLE_GLYPH: Readonly<Record<WorkloadRole, CardGlyph>> = {
  vm: 'vm',
  'app-container': 'appContainer',
  lxc: 'lxc',
  app: 'app',
  host: 'host',
}

/** Off is the cap's power hint: stopped or crashed. Unknown is neither. */
export function workloadIsOn(state: WorkloadState | null): boolean | null {
  if (state === null) return null
  return state !== 'stopped' && state !== 'crashed'
}

export const WORKLOAD_STATE_TONE: Readonly<Record<WorkloadState, CardTone>> = {
  running: 'success',
  paused: 'warning',
  stopped: 'muted',
  starting: 'info',
  stopping: 'info',
  crashed: 'danger',
}

export function workloadStateLabel(
  state: WorkloadState | null,
  role: WorkloadRole,
  t: UiTextFn,
): string {
  const host = role === 'host'
  switch (state) {
    case null:
      return t('uiLibrary.deviceCard.workload.state.unknown', 'State unknown')
    case 'running':
      return host
        ? t('uiLibrary.deviceCard.workload.state.online', 'Online')
        : t('uiLibrary.deviceCard.workload.state.running', 'Running')
    case 'paused':
      return t('uiLibrary.deviceCard.workload.state.paused', 'Paused')
    case 'stopped':
      return host
        ? t('uiLibrary.deviceCard.workload.state.shutDown', 'Shut down')
        : t('uiLibrary.deviceCard.workload.state.stopped', 'Stopped')
    case 'starting':
      return t('uiLibrary.deviceCard.workload.state.starting', 'Starting')
    case 'stopping':
      return t('uiLibrary.deviceCard.workload.state.stopping', 'Stopping')
    case 'crashed':
      return host
        ? t('uiLibrary.deviceCard.workload.state.down', 'Down')
        : t('uiLibrary.deviceCard.workload.state.crashed', 'Crashed')
  }
}

/** The word of an action; a host powers on, shuts down and reboots (the cap's role wording). */
export function workloadActionLabel(
  action: WorkloadAction,
  role: WorkloadRole,
  t: UiTextFn,
): string {
  const host = role === 'host'
  switch (action) {
    case 'start':
      return host
        ? t('uiLibrary.deviceCard.workload.action.powerOn', 'Power on')
        : t('uiLibrary.deviceCard.workload.action.start', 'Start')
    case 'stop':
      return host
        ? t('uiLibrary.deviceCard.workload.action.shutDown', 'Shut down')
        : t('uiLibrary.deviceCard.workload.action.stop', 'Stop')
    case 'restart':
      return host
        ? t('uiLibrary.deviceCard.workload.action.reboot', 'Reboot')
        : t('uiLibrary.deviceCard.workload.action.restart', 'Restart')
    case 'pause':
      return t('uiLibrary.deviceCard.workload.action.pause', 'Pause')
    case 'resume':
      return t('uiLibrary.deviceCard.workload.action.resume', 'Resume')
    case 'forceStop':
      return t('uiLibrary.deviceCard.workload.action.forceStop', 'Force stop')
  }
}

/**
 * The hero's actions in two columns, each holding only what the provider
 * declared. Lifecycle (right): start OR stop — the one the served state calls
 * for, both while the state is unknown — then restart. More (left): pause OR
 * resume, then force stop.
 */
export interface WorkloadControlColumns {
  readonly lifecycle: readonly WorkloadControl[]
  readonly more: readonly WorkloadControl[]
}

export function workloadControlColumns(
  controls: readonly WorkloadControl[],
  state: WorkloadState | null,
): WorkloadControlColumns {
  const on = workloadIsOn(state)
  const pick = (action: WorkloadAction): readonly WorkloadControl[] =>
    controls.filter((c) => c.action === action)
  return {
    lifecycle: [
      ...(on === true ? [] : pick('start')),
      ...(on === false ? [] : pick('stop')),
      ...pick('restart'),
    ],
    more: [...pick(state === 'paused' ? 'resume' : 'pause'), ...pick('forceStop')],
  }
}

/** What an unreported reading reads as: never 0 (D393). */
export const WORKLOAD_NO_VALUE = '—'

/** One hero gauge: a share of 0..100, null when not reported. */
export interface WorkloadGauge {
  readonly id: 'cpu' | 'memory'
  readonly label: string
  readonly percent: number | null
  /** "23%", or the dash when not reported. */
  readonly text: string
  /** "6.0 GB / 8.0 GB" when both amounts are reported; null otherwise. */
  readonly detail: string | null
}

/** CPU and RAM, always both: a value the provider did not report reads "—". */
export function workloadGauges(
  resources: WorkloadResources,
  t: UiTextFn,
): readonly [WorkloadGauge, WorkloadGauge] {
  const r = resources
  const used = r.memoryUsedBytes
  const total = r.memoryLimitBytes
  // Optional on the wire: absent is "not reported", the same as null.
  const memory =
    r.memoryPercent ?? (used !== null && total !== null && total > 0 ? (used / total) * 100 : null)
  const text = (value: number | null): string =>
    value === null ? WORKLOAD_NO_VALUE : percent(value)
  return [
    {
      id: 'cpu',
      label: t('uiLibrary.deviceCard.workload.cpu', 'CPU'),
      percent: r.cpuPercent,
      text: text(r.cpuPercent),
      detail: null,
    },
    {
      id: 'memory',
      label: t('uiLibrary.deviceCard.workload.ram', 'RAM'),
      percent: memory,
      text: text(memory),
      detail:
        used !== null && total !== null ? `${formatBytes(used)} / ${formatBytes(total)}` : null,
    },
  ]
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "3d 4h", "5h 12m", "12m", "<1m": the two largest units, a zero second unit left out. */
export function formatUptime(ms: number, t: UiTextFn): string {
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  if (days > 0) {
    return hours === 0
      ? t('uiLibrary.deviceCard.workload.uptime.d', '{{d}}d', { d: days })
      : t('uiLibrary.deviceCard.workload.uptime.dh', '{{d}}d {{h}}h', { d: days, h: hours })
  }
  if (hours > 0) {
    return minutes === 0
      ? t('uiLibrary.deviceCard.workload.uptime.h', '{{h}}h', { h: hours })
      : t('uiLibrary.deviceCard.workload.uptime.hm', '{{h}}h {{m}}m', { h: hours, m: minutes })
  }
  if (minutes > 0) return t('uiLibrary.deviceCard.workload.uptime.m', '{{m}}m', { m: minutes })
  return t('uiLibrary.deviceCard.workload.uptime.underMinute', '<1m')
}

/** How long since `since` (epoch ms), or null when that is not a real past instant. */
export function workloadUptime(since: number | null, now: number, t: UiTextFn): string | null {
  if (since === null || !Number.isFinite(since)) return null
  if (since < MIN_PLAUSIBLE_TIMESTAMP_MS || since > now) return null
  return formatUptime(now - since, t)
}

export function formatKbps(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(kbps >= 100_000 ? 0 : 1)} Mbit/s`
  return `${Math.round(kbps)} kbit/s`
}

const percent = (value: number): string => `${Math.round(value)}%`

/**
 * A share of a capacity as one short cell: the percent when it is reported or
 * can be computed, else the amount used. The capacity goes in the cell's name
 * ("Memory of 8.0 GB"), so a quarter-width cell never truncates.
 */
function usageStat(
  id: string,
  name: { readonly bare: string; readonly ofTotal: (total: string) => string },
  used: number | null,
  total: number | null,
  pct: number | null,
): RowStat | null {
  const share = pct ?? (used !== null && total !== null && total > 0 ? (used / total) * 100 : null)
  const value = share !== null ? percent(share) : used !== null ? formatBytes(used) : null
  if (value === null) return null
  return { id, name: total === null ? name.bare : name.ofTotal(formatBytes(total)), value }
}

/** One reading as a stat, or nothing when the provider did not report it. */
function stat(
  id: string,
  name: string,
  value: number | null,
  show: (v: number) => string,
): RowStat | null {
  return value === null ? null : { id, name, value: show(value) }
}

/**
 * The resource readings the provider reported, in a fixed order (what is used
 * first, then the machine, then the traffic); a null is left out.
 */
export function workloadResourceStats(
  resources: WorkloadResources,
  t: UiTextFn,
): readonly RowStat[] {
  const r = resources
  const stats: readonly (RowStat | null)[] = [
    stat('cpu', t('uiLibrary.deviceCard.workload.cpu', 'CPU'), r.cpuPercent, percent),
    usageStat(
      'memory',
      {
        bare: t('uiLibrary.deviceCard.workload.memory', 'Memory'),
        ofTotal: (total) =>
          t('uiLibrary.deviceCard.workload.memoryOf', 'Memory of {{total}}', { total }),
      },
      r.memoryUsedBytes,
      r.memoryLimitBytes,
      // Optional on the wire: absent is "not reported", the same as null.
      r.memoryPercent ?? null,
    ),
    usageStat(
      'disk',
      {
        bare: t('uiLibrary.deviceCard.workload.disk', 'Disk'),
        ofTotal: (total) =>
          t('uiLibrary.deviceCard.workload.diskOf', 'Disk of {{total}}', { total }),
      },
      r.diskUsedBytes,
      r.diskTotalBytes,
      null,
    ),
    stat(
      'temperature',
      t('uiLibrary.deviceCard.workload.temperature', 'Temperature'),
      r.temperature,
      (v) => `${Math.round(v)} °C`,
    ),
    stat('load', t('uiLibrary.deviceCard.workload.load', 'Load'), r.load1, (v) => v.toFixed(2)),
    stat('vcpus', t('uiLibrary.deviceCard.workload.vcpus', 'vCPUs'), r.vcpus, String),
    stat('net-rx', t('uiLibrary.deviceCard.workload.netRx', 'Received'), r.netRxKbps, formatKbps),
    stat('net-tx', t('uiLibrary.deviceCard.workload.netTx', 'Sent'), r.netTxKbps, formatKbps),
  ]
  return stats.filter((s): s is RowStat => s !== null)
}

/** The readings under the hero: everything but CPU and memory, which are its gauges. */
export function workloadExtraStats(resources: WorkloadResources, t: UiTextFn): readonly RowStat[] {
  return workloadResourceStats(resources, t).filter((s) => s.id !== 'cpu' && s.id !== 'memory')
}

/** "8096/tcp → 8096", "53/udp": the container port, then where the host publishes it. */
export function workloadPortText(port: WorkloadPort): string {
  const inner = `${port.port}/${port.protocol}`
  if (port.hostPort === null) return inner
  const outer = port.hostIp === null ? String(port.hostPort) : `${port.hostIp}:${port.hostPort}`
  return `${inner} → ${outer}`
}

/** Splits stats into rows of at most `size`, the most a stats row holds. */
export function chunkStats(stats: readonly RowStat[], size = 4): readonly (readonly RowStat[])[] {
  const rows: RowStat[][] = []
  for (let i = 0; i < stats.length; i += size) rows.push(stats.slice(i, i + size))
  return rows
}

/**
 * Rows of at most `max` stats that share them evenly: four is two and two,
 * never three and a lone one stretched across the card.
 */
export function balancedStatRows(
  stats: readonly RowStat[],
  max = 3,
): readonly (readonly RowStat[])[] {
  if (stats.length === 0) return []
  const rows = Math.ceil(stats.length / max)
  return chunkStats(stats, Math.ceil(stats.length / rows))
}
