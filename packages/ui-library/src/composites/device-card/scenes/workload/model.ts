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
  /** "3 d", how long it has been in this state; null when not reported. */
  readonly since: string | null
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
 * Power on the scene: both start and stop are declared and the state is
 * known. The toggle answers only while the move it would make is allowed.
 */
export interface WorkloadScenePower {
  readonly on: boolean
  readonly enabled: boolean
}

export function workloadScenePower(
  controls: readonly WorkloadControl[],
  state: WorkloadState | null,
): WorkloadScenePower | null {
  const on = workloadIsOn(state)
  const start = controls.find((c) => c.action === 'start')
  const stop = controls.find((c) => c.action === 'stop')
  if (on === null || start === undefined || stop === undefined) return null
  return { on, enabled: on ? stop.enabled : start.enabled }
}

/**
 * The column's controls. Start / stop sit on the scene when it is the power
 * toggle; otherwise each declared one is a button. Pause and resume share one
 * slot: the one the state calls for.
 */
export function workloadColumnControls(
  controls: readonly WorkloadControl[],
  scenePower: boolean,
  state: WorkloadState | null,
): readonly WorkloadControl[] {
  return controls.filter((c) => {
    if (scenePower && (c.action === 'start' || c.action === 'stop')) return false
    if (c.action === 'pause') return state !== 'paused'
    if (c.action === 'resume') return state === 'paused'
    return true
  })
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
