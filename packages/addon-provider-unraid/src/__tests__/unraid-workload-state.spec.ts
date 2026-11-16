/**
 * What an Unraid Docker container, VM and the server itself report through the `workload`
 * cap: the state, what is known, and only the controls node-unraid really serves.
 */
import {
  DeviceRole,
  WorkloadStatusSchema,
  deriveWorkloadControls,
  workloadTransition,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { UnraidContainerInfo, UnraidSnapshot } from '../unraid-client-contract.js'
import type { UnraidInstanceStatus } from '../unraid-integration-manager.js'
import {
  unraidHostWorkloadStatus,
  unraidServerReach,
  UNRAID_HOST_WORKLOAD_OPTIONS,
  unraidWorkloadOptions,
  unraidWorkloadRole,
  unraidWorkloadStatus,
} from '../unraid-workload-state.js'

const NOW = 5_000

const plex: UnraidContainerInfo = {
  id: 'srv:aaa',
  name: 'plex',
  state: 'running',
  image: 'plexinc/pms-docker:latest',
  autostart: true,
  updateAvailable: false,
  cpuPercent: 12,
  memPercent: 7,
}

describe('unraidWorkloadRole', () => {
  it('a container is an app container, a VM a vm', () => {
    expect(unraidWorkloadRole('docker')).toBe(DeviceRole.AppContainer)
    expect(unraidWorkloadRole('vm')).toBe(DeviceRole.Vm)
  })
})

describe('unraidWorkloadStatus — a container', () => {
  it('reports its state, image, autostart, update and CPU, and the server as its host', () => {
    const status = unraidWorkloadStatus({ kind: 'docker', container: plex }, 42, NOW)
    expect(status).toMatchObject({
      state: 'running',
      hostDeviceId: 42,
      image: 'plexinc/pms-docker:latest',
      autostart: true,
      updateAvailable: false,
      lastFetchedAt: NOW,
    })
    expect(status.resources.cpuPercent).toBe(12)
    // The API reports memory as a share of the limit, not in bytes.
    expect(status.resources.memoryPercent).toBe(7)
    expect(status.resources.memoryUsedBytes).toBeNull()
    expect(WorkloadStatusSchema.parse(status)).toEqual(status)
  })

  it('a paused container is paused, an exited one stopped', () => {
    const paused = { ...plex, state: 'paused' as const }
    const exited = { ...plex, state: 'exited' as const }
    expect(unraidWorkloadStatus({ kind: 'docker', container: paused }, null, NOW).state).toBe(
      'paused',
    )
    expect(unraidWorkloadStatus({ kind: 'docker', container: exited }, null, NOW).state).toBe(
      'stopped',
    )
  })

  it('a workload missing from the snapshot is unknown (null), never stopped', () => {
    const status = unraidWorkloadStatus(null, 42, NOW)
    expect(status.state).toBeNull()
    expect(status.hostDeviceId).toBe(42)
  })
})

describe('unraidWorkloadStatus — a VM', () => {
  it.each([
    ['running', 'running'],
    ['paused', 'paused'],
    ['stopping', 'stopping'],
    ['shut off', 'stopped'],
    ['crashed', 'crashed'],
    ['unknown', null],
  ] as const)('libvirt %s is %s', (vmState, state) => {
    const status = unraidWorkloadStatus(
      { kind: 'vm', vm: { id: 'srv:uuid', name: 'CCU3', state: vmState } },
      42,
      NOW,
    )
    expect(status.state).toBe(state)
  })
})

describe('unraidWorkloadOptions — honest per kind', () => {
  it('a container starts, stops, restarts (stop then start) and pauses; no force stop', () => {
    expect(unraidWorkloadOptions('docker')).toMatchObject({
      supportsStart: true,
      supportsStop: true,
      supportsPause: true,
      supportsRestart: true,
      supportsForceStop: false,
      hasResources: true,
      hasAutostart: true,
      hasUpdateCheck: true,
    })
  })

  it('a VM starts, stops, reboots, pauses and force-stops; it reports no resources', () => {
    expect(unraidWorkloadOptions('vm')).toMatchObject({
      supportsStart: true,
      supportsStop: true,
      supportsRestart: true,
      supportsPause: true,
      supportsForceStop: true,
      hasResources: false,
    })
  })
})

describe('the server as the host', () => {
  function server(over: Partial<UnraidSnapshot> = {}): UnraidSnapshot {
    return {
      array: {
        state: 'STARTED',
        capacityKb: { total: 1, used: 0, free: 1 },
        parityCheck: null,
        disks: [],
      },
      cpu: { percent: 33, tempC: 48, powerW: null },
      disks: [],
      dockers: [],
      vms: [],
      notifications: { activeCount: 0, latest: null },
      ...over,
    }
  }

  const answering = (snapshot: UnraidSnapshot) => ({ kind: 'answering' as const, snapshot })

  it('a polled server is running with its CPU and temperature', () => {
    const status = unraidHostWorkloadStatus(answering(server()), NOW)
    expect(status.state).toBe('running')
    expect(status.os).toBe('Unraid')
    expect(status.resources.cpuPercent).toBe(33)
    expect(status.resources.temperature).toBe(48)
    expect(status.hostDeviceId).toBeNull()
  })

  it('not yet polled is unknown, never stopped', () => {
    expect(unraidHostWorkloadStatus({ kind: 'unknown' }, NOW).state).toBeNull()
  })

  it('a server that stops answering went down, and coming back is a recovery — never still running', () => {
    const down = unraidHostWorkloadStatus({ kind: 'unreachable' }, NOW)
    expect(down.state).toBe('crashed')
    expect(down.resources.cpuPercent).toBeNull()
    expect(workloadTransition('running', down.state)).toBe('crashed')
    const back = unraidHostWorkloadStatus(answering(server()), NOW)
    expect(workloadTransition('crashed', back.state)).toBe('recovered')
  })

  describe('unraidServerReach — what the last poll says', () => {
    const snap = server()
    const view = (
      status: UnraidInstanceStatus,
      error: string | null,
      snapshot: UnraidSnapshot | null,
    ) => ({
      status,
      error,
      getSnapshot: () => snapshot,
    })

    it('a connected manager whose last poll failed is unreachable, even with an old snapshot', () => {
      expect(unraidServerReach(view('connected', 'ECONNREFUSED', snap)).kind).toBe('unreachable')
    })

    it('a connected manager with a fresh snapshot is answering', () => {
      expect(unraidServerReach(view('connected', null, snap)).kind).toBe('answering')
    })

    it('no manager, or one still connecting or stopped, is unknown', () => {
      expect(unraidServerReach(null).kind).toBe('unknown')
      expect(unraidServerReach(view('connecting', null, null)).kind).toBe('unknown')
      expect(unraidServerReach(view('disconnected', null, null)).kind).toBe('unknown')
    })

    it('a manager in error is unreachable', () => {
      expect(unraidServerReach(view('error', 'boom', null)).kind).toBe('unreachable')
    })
  })

  it('the server declares no control the API does not serve', () => {
    expect(deriveWorkloadControls(UNRAID_HOST_WORKLOAD_OPTIONS, 'running').controls).toEqual([])
  })
})
