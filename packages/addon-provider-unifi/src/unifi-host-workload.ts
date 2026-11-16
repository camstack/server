/**
 * A UniFi console, switch or access point as a `workload` host (D1056): its state, uptime,
 * CPU and temperature from the infra snapshot. Pure.
 *
 * Only what the controller reports is filled; everything else is `null` (D393). A host
 * declares no control: its restart stays the restart Button child, and there is no start
 * or stop, so no power switch is registered.
 */
import type {
  WorkloadOptions,
  WorkloadResources,
  WorkloadState,
  WorkloadStatus,
} from '@camstack/types'
import type { UnifiInfraSnapshot, UnifiInfraState } from './unifi-client-contract.js'

/** What a UniFi host declares: its resources, nothing it cannot do. */
export const UNIFI_HOST_WORKLOAD_OPTIONS: WorkloadOptions = {
  supportsStart: false,
  supportsStop: false,
  supportsRestart: false,
  supportsPause: false,
  supportsForceStop: false,
  hasResources: true,
  hasPorts: false,
  hasAddresses: false,
  hasAutostart: false,
  hasUpdateCheck: false,
}

/** The slice a host seeds before its first snapshot: nothing is known. */
export const UNIFI_HOST_WORKLOAD_UNKNOWN: WorkloadStatus = {
  state: null,
  since: null,
  hostDeviceId: null,
  image: null,
  os: null,
  version: null,
  autostart: null,
  resources: emptyResources(),
  ports: [],
  addresses: [],
  updateAvailable: null,
  lastFetchedAt: 0,
}

function emptyResources(): WorkloadResources {
  return {
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryLimitBytes: null,
    vcpus: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    netRxKbps: null,
    netTxKbps: null,
    load1: null,
    temperature: null,
  }
}

/**
 * The controller's device state as a workload state. Offline is `crashed`: the device went
 * down without anyone asking it to stop (no stop is served), so it raises "went down" and its
 * return "came online" — never "shut down". An upgrade restarts it; pending / adopting /
 * unknown say nothing about whether it runs, so they are unknown (`null`).
 */
function hostState(state: UnifiInfraState): WorkloadState | null {
  switch (state) {
    case 'online':
      return 'running'
    case 'offline':
      return 'crashed'
    case 'upgrading':
      return 'starting'
    case 'pending':
    case 'adopting':
    case 'unknown':
      return null
  }
}

const MS_PER_SEC = 1000
/**
 * Two readings of one boot differ by the poll's jitter and the uptime's whole seconds; a boot
 * that moved further than this is a restart.
 */
const SAME_BOOT_TOLERANCE_MS = 60_000

/**
 * When the host booted: the previous `since` while the reading is the same boot (so it does not
 * drift every poll), else the new boot time rounded to the second.
 */
function bootSince(uptimeSec: number, now: number, previous: WorkloadStatus): number {
  const bootAt = Math.round((now - uptimeSec * MS_PER_SEC) / MS_PER_SEC) * MS_PER_SEC
  const kept = previous.state === 'running' ? previous.since : null
  if (kept !== null && Math.abs(bootAt - kept) <= SAME_BOOT_TOLERANCE_MS) return kept
  return bootAt
}

/**
 * The `workload` slice of one infra device. `infra` is null when the controller's last read
 * failed or no longer lists the device: the state is then unknown (D315), never the last
 * `running` a reachable controller reported.
 */
export function unifiHostWorkloadStatus(
  infra: UnifiInfraSnapshot | null,
  now: number,
  previous: WorkloadStatus = UNIFI_HOST_WORKLOAD_UNKNOWN,
): WorkloadStatus {
  if (infra === null) {
    return { ...UNIFI_HOST_WORKLOAD_UNKNOWN, lastFetchedAt: previous.lastFetchedAt }
  }
  const state = hostState(infra.state)
  return {
    ...UNIFI_HOST_WORKLOAD_UNKNOWN,
    state,
    since:
      state === 'running' && infra.uptimeSec !== null
        ? bootSince(infra.uptimeSec, now, previous)
        : null,
    resources: {
      ...emptyResources(),
      cpuPercent: infra.cpuPercent,
      temperature: infra.cpuTempC,
    },
    lastFetchedAt: now,
  }
}
