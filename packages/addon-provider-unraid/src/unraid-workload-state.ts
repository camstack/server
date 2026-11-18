/**
 * The `workload` cap (D1056) of an Unraid server, Docker container and VM: the role each is
 * adopted with, what each declares through `getOptions`, and its slice from the poll
 * snapshot. Pure.
 *
 * Only what the API reports is filled; everything else is `null` (D393). The controls are
 * the ones node-unraid serves: a container starts, stops, pauses and unpauses, and restarts
 * as stop then start (the API has no atomic restart; no force stop); a VM starts, stops, reboots, pauses, resumes and force-stops; the server
 * itself has none.
 */
import {
  DeviceRole,
  type WorkloadOptions,
  type WorkloadResources,
  type WorkloadState,
  type WorkloadStatus,
} from '@camstack/types'
import type {
  UnraidContainerState,
  UnraidSnapshot,
  UnraidVmState,
} from './unraid-client-contract.js'
import { knownArrayCapacityBytes } from './unraid-array-capacity.js'
import type { UnraidInstanceStatus } from './unraid-integration-manager.js'
import type { UnraidWorkloadMatch, UnraidWorkloadRef } from './unraid-discovery.js'

/** The workload kinds an adopted container or VM can be. */
export type UnraidWorkloadKind = UnraidWorkloadRef['kind']

/** The role a container or a VM is adopted with. */
export function unraidWorkloadRole(kind: UnraidWorkloadKind): DeviceRole {
  return kind === 'docker' ? DeviceRole.AppContainer : DeviceRole.Vm
}

const NO_OPTIONS: WorkloadOptions = {
  supportsStart: false,
  supportsStop: false,
  supportsRestart: false,
  supportsPause: false,
  supportsForceStop: false,
  hasResources: false,
  hasPorts: false,
  hasAddresses: false,
  hasAutostart: false,
  hasUpdateCheck: false,
}

const DOCKER_OPTIONS: WorkloadOptions = {
  ...NO_OPTIONS,
  supportsStart: true,
  supportsStop: true,
  supportsRestart: true,
  supportsPause: true,
  hasResources: true,
  hasAutostart: true,
  hasUpdateCheck: true,
}

const VM_OPTIONS: WorkloadOptions = {
  ...NO_OPTIONS,
  supportsStart: true,
  supportsStop: true,
  supportsRestart: true,
  supportsPause: true,
  supportsForceStop: true,
}

/** What the server declares: its resources, no control (the API has none for it). */
export const UNRAID_HOST_WORKLOAD_OPTIONS: WorkloadOptions = { ...NO_OPTIONS, hasResources: true }

/** What a container or a VM declares. */
export function unraidWorkloadOptions(kind: UnraidWorkloadKind): WorkloadOptions {
  return kind === 'docker' ? DOCKER_OPTIONS : VM_OPTIONS
}

function emptyResources(): WorkloadResources {
  return {
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryPercent: null,
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

/** A slice where nothing is known yet. */
export function unknownWorkloadStatus(hostDeviceId: number | null, now: number): WorkloadStatus {
  return {
    state: null,
    since: null,
    hostDeviceId,
    image: null,
    os: null,
    version: null,
    autostart: null,
    resources: emptyResources(),
    ports: [],
    addresses: [],
    updateAvailable: null,
    lastFetchedAt: now,
  }
}

function containerState(state: UnraidContainerState): WorkloadState | null {
  switch (state) {
    case 'running':
      return 'running'
    case 'paused':
      return 'paused'
    case 'exited':
      return 'stopped'
    case 'unknown':
      return null
  }
}

function vmState(state: UnraidVmState): WorkloadState | null {
  switch (state) {
    case 'running':
      return 'running'
    case 'paused':
      return 'paused'
    case 'stopping':
      return 'stopping'
    case 'shut off':
      return 'stopped'
    case 'crashed':
      return 'crashed'
    case 'unknown':
      return null
  }
}

/**
 * The slice of an adopted container or VM. `match` null = not in the snapshot, or its list
 * could not be read: unknown, never stopped.
 */
export function unraidWorkloadStatus(
  match: UnraidWorkloadMatch | null,
  hostDeviceId: number | null,
  now: number,
): WorkloadStatus {
  const base = unknownWorkloadStatus(hostDeviceId, now)
  if (match === null) return base
  if (match.kind === 'vm') return { ...base, state: vmState(match.vm.state) }
  const { container } = match
  return {
    ...base,
    state: containerState(container.state),
    image: container.image,
    autostart: container.autostart,
    updateAvailable: container.updateAvailable,
    resources: {
      ...emptyResources(),
      cpuPercent: container.cpuPercent,
      memoryPercent: container.memPercent,
    },
  }
}

/**
 * What the last poll says about the server. A failed poll keeps the old snapshot in the
 * manager, so the snapshot alone would keep a server that stopped answering "running".
 */
export type UnraidServerReach =
  | { readonly kind: 'answering'; readonly snapshot: UnraidSnapshot }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'unknown' }

/** The part of the integration manager the reach is read from. */
export interface UnraidPollView {
  readonly status: UnraidInstanceStatus
  readonly error: string | null
  getSnapshot(): UnraidSnapshot | null
}

/**
 * Answering = connected and the last poll landed; unreachable = connected but the last poll
 * failed, or the manager is in error; unknown = no manager yet, connecting, or stopped.
 */
export function unraidServerReach(manager: UnraidPollView | null): UnraidServerReach {
  if (manager === null) return { kind: 'unknown' }
  if (manager.status === 'error') return { kind: 'unreachable' }
  if (manager.status !== 'connected') return { kind: 'unknown' }
  if (manager.error !== null) return { kind: 'unreachable' }
  const snapshot = manager.getSnapshot()
  return snapshot === null ? { kind: 'unknown' } : { kind: 'answering', snapshot }
}

/** The live snapshot when the server answered its last poll, else null (D393). */
export function answeringSnapshot(reach: UnraidServerReach): UnraidSnapshot | null {
  return reach.kind === 'answering' ? reach.snapshot : null
}

/**
 * The slice of the server itself: running while it answers the poll, with CPU, temperature
 * and the array's used / total capacity as its disk; `crashed` once it stops answering (the
 * host's "went down", and a recovery when it answers again); unknown before the first poll.
 */
export function unraidHostWorkloadStatus(reach: UnraidServerReach, now: number): WorkloadStatus {
  const base = unknownWorkloadStatus(null, now)
  if (reach.kind === 'unknown') return base
  if (reach.kind === 'unreachable') return { ...base, state: 'crashed' }
  const { snapshot } = reach
  const capacity = knownArrayCapacityBytes(snapshot.array.capacityKb)
  return {
    ...base,
    state: 'running',
    os: 'Unraid',
    resources: {
      ...emptyResources(),
      cpuPercent: snapshot.cpu.percent,
      temperature: snapshot.cpu.tempC,
      // The array's capacity; unknown when the server did not report it or the array is
      // stopped (D393). Uptime and RAM are not read by the client.
      diskUsedBytes: capacity?.used ?? null,
      diskTotalBytes: capacity?.total ?? null,
    },
  }
}
