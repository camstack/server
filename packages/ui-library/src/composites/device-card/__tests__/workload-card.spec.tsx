// @vitest-environment jsdom
/**
 * The workload card (#585): which card the type resolves to, the pure model
 * (state words, the power toggle, which controls sit in the column, the
 * resources drawn only when reported) and the card itself — an undeclared
 * action has no button, an unknown state is never "Stopped".
 */
import {
  DeviceType,
  deriveWorkloadControls,
  type WorkloadOptions,
  type WorkloadResources,
  type WorkloadState,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { deviceCommon } from '../__fixtures__/wave-d-common'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import {
  chunkStats,
  type WorkloadCardModel,
  workloadColumnControls,
  workloadPortText,
  workloadResourceStats,
  workloadRoleOf,
  workloadScenePower,
  workloadStateLabel,
} from '../scenes/workload/model'
import { WorkloadCard } from '../scenes/workload/WorkloadCard'

afterEach(cleanup)

const t = defaultUiText

const NO_RESOURCES: WorkloadResources = {
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

const ALL: WorkloadOptions = {
  supportsStart: true,
  supportsStop: true,
  supportsRestart: true,
  supportsPause: true,
  supportsForceStop: true,
  hasResources: true,
  hasPorts: true,
  hasAddresses: true,
  hasAutostart: true,
  hasUpdateCheck: true,
}

function model(
  state: WorkloadState | null,
  options: WorkloadOptions,
  patch: Partial<WorkloadCardModel> = {},
): WorkloadCardModel {
  const derived = deriveWorkloadControls(options, state)
  return {
    common: deviceCommon({ name: 'Media server', integration: 'Unraid' }),
    role: 'app-container',
    state,
    since: null,
    controls: derived.controls,
    sections: derived.sections,
    resources: NO_RESOURCES,
    image: null,
    os: null,
    version: null,
    autostart: null,
    ports: [],
    addresses: [],
    updateAvailable: null,
    host: null,
    ...patch,
  }
}

describe('connectedCardKindOf — workload', () => {
  it('draws the workload card only when the device binds `workload`', () => {
    expect(connectedCardKindOf(DeviceType.Workload, 'vm', ['workload', 'switch'])).toBe('workload')
    expect(connectedCardKindOf(DeviceType.Workload, 'vm', ['switch'])).toBeNull()
  })
})

describe('workload model', () => {
  it('reads an unrecognised role as an app', () => {
    expect(workloadRoleOf('vm')).toBe('vm')
    expect(workloadRoleOf('host')).toBe('host')
    expect(workloadRoleOf(null)).toBe('app')
    expect(workloadRoleOf('toaster')).toBe('app')
  })

  it('says unknown for a null state, never stopped (D315)', () => {
    expect(workloadStateLabel(null, 'vm', t)).toBe('State unknown')
    expect(workloadStateLabel('stopped', 'vm', t)).toBe('Stopped')
    expect(workloadStateLabel('stopped', 'host', t)).toBe('Shut down')
    expect(workloadStateLabel('running', 'host', t)).toBe('Online')
  })

  it('puts power on the scene only when start and stop are declared and the state is known', () => {
    const both = deriveWorkloadControls(ALL, 'running').controls
    expect(workloadScenePower(both, 'running')).toEqual({ on: true, enabled: true })
    const stopped = deriveWorkloadControls(ALL, 'stopped').controls
    expect(workloadScenePower(stopped, 'stopped')).toEqual({ on: false, enabled: true })
    expect(
      workloadScenePower(deriveWorkloadControls(ALL, 'stopping').controls, 'stopping'),
    ).toEqual({ on: true, enabled: false })
    expect(workloadScenePower(both, null)).toBeNull()
    const restartOnly = deriveWorkloadControls(
      { ...ALL, supportsStart: false, supportsStop: false },
      'running',
    ).controls
    expect(workloadScenePower(restartOnly, 'running')).toBeNull()
  })

  it('keeps start / stop off the column when they are the scene toggle, and shows pause or resume by state', () => {
    const running = deriveWorkloadControls(ALL, 'running').controls
    expect(workloadColumnControls(running, true, 'running').map((c) => c.action)).toEqual([
      'restart',
      'pause',
      'forceStop',
    ])
    const paused = deriveWorkloadControls(ALL, 'paused').controls
    expect(workloadColumnControls(paused, true, 'paused').map((c) => c.action)).toEqual([
      'restart',
      'resume',
      'forceStop',
    ])
    expect(workloadColumnControls(running, false, null).map((c) => c.action)).toContain('start')
  })

  it('draws only the resources the provider reported', () => {
    expect(workloadResourceStats(NO_RESOURCES, t)).toEqual([])
    const stats = workloadResourceStats(
      {
        ...NO_RESOURCES,
        cpuPercent: 23.4,
        memoryUsedBytes: 2 * 1024 ** 3,
        memoryLimitBytes: 8 * 1024 ** 3,
        netRxKbps: 1840,
      },
      t,
    )
    expect(stats.map((s) => s.id)).toEqual(['cpu', 'memory', 'net-rx'])
    expect(stats[0]?.value).toBe('23%')
    expect(stats[1]?.value).toBe('25%')
    expect(stats[2]?.value).toBe('1.8 Mbit/s')
  })

  it('prefers a reported memory percent, and falls back to the bytes used without a total', () => {
    const [reported] = workloadResourceStats(
      { ...NO_RESOURCES, memoryPercent: 75, memoryUsedBytes: 1, memoryLimitBytes: 100 },
      t,
    )
    expect(reported?.value).toBe('75%')
    const [bare] = workloadResourceStats({ ...NO_RESOURCES, memoryUsedBytes: 1024 ** 3 }, t)
    expect(bare?.name).toBe('Memory')
  })

  it('writes a port as container port, then where the host publishes it', () => {
    expect(workloadPortText({ port: 8096, hostPort: 8096, hostIp: null, protocol: 'tcp' })).toBe(
      '8096/tcp → 8096',
    )
    expect(workloadPortText({ port: 53, hostPort: null, hostIp: null, protocol: 'udp' })).toBe(
      '53/udp',
    )
  })

  it('splits stats into rows of at most the given size', () => {
    const s = (id: string) => ({ id, name: id, value: id })
    expect(chunkStats([s('a'), s('b'), s('c'), s('d')], 3).map((r) => r.length)).toEqual([3, 1])
  })
})

describe('WorkloadCard', () => {
  it('draws no button for an undeclared action', () => {
    render(
      <WorkloadCard
        model={model('running', { ...ALL, supportsPause: false, supportsForceStop: false })}
        actions={{ onAction: vi.fn() }}
      />,
    )
    expect(screen.queryByTestId('dc-workload-pause')).toBeNull()
    expect(screen.queryByTestId('dc-workload-forceStop')).toBeNull()
    expect(screen.getByTestId('dc-workload-restart')).toBeTruthy()
    expect(screen.getByTestId('dc-workload-power')).toBeTruthy()
  })

  it('toggles power on the scene', () => {
    const onAction = vi.fn()
    render(<WorkloadCard model={model('stopped', ALL)} actions={{ onAction }} />)
    fireEvent.click(screen.getByTestId('dc-workload-power'))
    expect(onAction).toHaveBeenCalledWith('start')
  })

  it('asks twice before a force stop', () => {
    const onAction = vi.fn()
    render(<WorkloadCard model={model('running', ALL)} actions={{ onAction }} />)
    fireEvent.click(screen.getByTestId('dc-workload-forceStop'))
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-workload-forceStop'))
    expect(onAction).toHaveBeenCalledWith('forceStop')
  })

  it('reads an unknown state as unknown and offers start and stop as buttons', () => {
    render(<WorkloadCard model={model(null, ALL)} actions={{ onAction: vi.fn() }} />)
    expect(screen.getByText('State unknown')).toBeTruthy()
    expect(screen.queryByText('Stopped')).toBeNull()
    expect(screen.queryByTestId('dc-workload-power')).toBeNull()
    expect(screen.getByTestId('dc-workload-start')).toBeTruthy()
    expect(screen.getByTestId('dc-workload-stop')).toBeTruthy()
  })

  it('opens the host only where the page offers a device view', () => {
    const host = { deviceId: 983, name: 'Tower' }
    const { rerender } = render(
      <WorkloadCard model={model('running', ALL, { host })} actions={{ onAction: vi.fn() }} />,
    )
    expect(screen.queryByTestId('dc-workload-host')).toBeNull()
    const onOpenDevice = vi.fn()
    rerender(
      <WorkloadCard
        model={model('running', ALL, { host })}
        actions={{ onAction: vi.fn(), onOpenDevice }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-workload-host'))
    expect(onOpenDevice).toHaveBeenCalledWith(983)
  })

  it('draws ports, addresses and the update notice only when declared', () => {
    const patch = {
      ports: [{ port: 80, hostPort: 8080, hostIp: null, protocol: 'tcp' as const }],
      addresses: ['192.0.2.1'],
      updateAvailable: true,
    }
    render(
      <WorkloadCard
        model={model(
          'running',
          { ...ALL, hasPorts: false, hasAddresses: false, hasUpdateCheck: false },
          patch,
        )}
        actions={{ onAction: vi.fn() }}
      />,
    )
    expect(screen.queryByTestId('dc-workload-ports')).toBeNull()
    expect(screen.queryByTestId('dc-workload-addresses')).toBeNull()
    expect(screen.queryByTestId('dc-workload-update')).toBeNull()
    cleanup()
    render(<WorkloadCard model={model('running', ALL, patch)} actions={{ onAction: vi.fn() }} />)
    expect(screen.getByText('80/tcp → 8080')).toBeTruthy()
    expect(screen.getByTestId('dc-workload-addresses')).toBeTruthy()
    expect(screen.getByTestId('dc-workload-update')).toBeTruthy()
  })
})
