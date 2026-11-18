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
  balancedStatRows,
  chunkStats,
  formatUptime,
  type WorkloadCardModel,
  workloadControlColumns,
  workloadExtraStats,
  workloadGauges,
  workloadPortText,
  workloadResourceStats,
  workloadRoleOf,
  workloadStateLabel,
  workloadUptime,
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
    uptime: null,
    busy: false,
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

  it('draws only the declared lifecycle actions, start or stop by the served state', () => {
    const actions = (options: WorkloadOptions, state: WorkloadState | null) => {
      const cols = workloadControlColumns(deriveWorkloadControls(options, state).controls, state)
      return {
        lifecycle: cols.lifecycle.map((c) => c.action),
        more: cols.more.map((c) => c.action),
      }
    }
    expect(actions(ALL, 'running')).toEqual({
      lifecycle: ['stop', 'restart'],
      more: ['pause', 'forceStop'],
    })
    // Declared but not possible in this state: drawn disabled, never hidden.
    expect(actions(ALL, 'stopped')).toEqual({
      lifecycle: ['start', 'restart'],
      more: ['pause', 'forceStop'],
    })
    expect(actions(ALL, 'paused').more).toEqual(['resume', 'forceStop'])
    // Unknown: both, never a guess at which one applies.
    expect(actions(ALL, null).lifecycle).toEqual(['start', 'stop', 'restart'])
    // Undeclared actions have no slot at all.
    expect(
      actions(
        { ...ALL, supportsStop: false, supportsPause: false, supportsForceStop: false },
        'running',
      ),
    ).toEqual({ lifecycle: ['restart'], more: [] })
    expect(
      actions(
        { ...ALL, supportsStart: false, supportsStop: false, supportsRestart: false },
        'running',
      ).lifecycle,
    ).toEqual([])
  })

  it('reads an absent CPU or memory value as a dash, never 0 (D393)', () => {
    const [cpu, memory] = workloadGauges(NO_RESOURCES, t)
    expect(cpu).toMatchObject({ id: 'cpu', percent: null, text: '—', detail: null })
    expect(memory).toMatchObject({ id: 'memory', percent: null, text: '—', detail: null })
    const [, onlyTotal] = workloadGauges({ ...NO_RESOURCES, memoryLimitBytes: 8 * 1024 ** 3 }, t)
    expect(onlyTotal?.text).toBe('—')
    const [zeroCpu] = workloadGauges({ ...NO_RESOURCES, cpuPercent: 0 }, t)
    expect(zeroCpu).toMatchObject({ percent: 0, text: '0%' })
  })

  it('labels the gauges with a percent, and RAM with used / total when reported', () => {
    const [cpu, memory] = workloadGauges(
      {
        ...NO_RESOURCES,
        cpuPercent: 23.4,
        memoryUsedBytes: 6 * 1024 ** 3,
        memoryLimitBytes: 8 * 1024 ** 3,
      },
      t,
    )
    expect(cpu).toMatchObject({ percent: 23.4, text: '23%' })
    expect(memory).toMatchObject({ percent: 75, text: '75%', detail: '6.0 GB / 8.0 GB' })
    const [, reported] = workloadGauges({ ...NO_RESOURCES, memoryPercent: 41 }, t)
    expect(reported).toMatchObject({ percent: 41, text: '41%', detail: null })
  })

  it('keeps the bytes used when no total or percent is reported: a reading, not a dash (D393)', () => {
    const [, memory] = workloadGauges({ ...NO_RESOURCES, memoryUsedBytes: 6 * 1024 ** 3 }, t)
    expect(memory).toMatchObject({ percent: null, text: '—', detail: '6.0 GB' })
  })

  it('keeps CPU and memory out of the stats under the gauges', () => {
    const stats = workloadExtraStats(
      { ...NO_RESOURCES, cpuPercent: 5, memoryPercent: 10, vcpus: 4, netRxKbps: 10 },
      t,
    )
    expect(stats.map((s) => s.id)).toEqual(['vcpus', 'net-rx'])
  })

  it('writes the uptime compactly, in at most two units', () => {
    const MIN = 60_000
    const HOUR = 60 * MIN
    const DAY = 24 * HOUR
    expect(formatUptime(3 * DAY + 4 * HOUR + 5 * MIN, t)).toBe('3d 4h')
    expect(formatUptime(3 * DAY, t)).toBe('3d')
    expect(formatUptime(5 * HOUR + 12 * MIN, t)).toBe('5h 12m')
    expect(formatUptime(2 * HOUR, t)).toBe('2h')
    expect(formatUptime(12 * MIN + 30_000, t)).toBe('12m')
    expect(formatUptime(20_000, t)).toBe('<1m')
  })

  it('has no uptime for an unknown, seeded or future instant', () => {
    const now = Date.UTC(2026, 10, 18)
    expect(workloadUptime(now - 3_600_000, now, t)).toBe('1h')
    expect(workloadUptime(null, now, t)).toBeNull()
    expect(workloadUptime(1, now, t)).toBeNull()
    expect(workloadUptime(now + 60_000, now, t)).toBeNull()
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

  it('shares stats evenly across rows of at most three', () => {
    const s = (id: string) => ({ id, name: id, value: id })
    const sizes = (n: number) =>
      balancedStatRows(
        Array.from({ length: n }, (_, i) => s(String(i))),
        3,
      ).map((r) => r.length)
    expect(sizes(0)).toEqual([])
    expect(sizes(3)).toEqual([3])
    expect(sizes(4)).toEqual([2, 2])
    expect(sizes(5)).toEqual([3, 2])
    expect(sizes(7)).toEqual([3, 3, 1])
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
    expect(screen.getByTestId('dc-workload-stop')).toBeTruthy()
    expect(screen.queryByTestId('dc-workload-start')).toBeNull()
  })

  it('starts in one tap, and asks twice before a stop', () => {
    const onAction = vi.fn()
    const { rerender } = render(
      <WorkloadCard model={model('stopped', ALL)} actions={{ onAction }} />,
    )
    fireEvent.click(screen.getByTestId('dc-workload-start'))
    expect(onAction).toHaveBeenCalledWith('start')
    onAction.mockClear()
    rerender(<WorkloadCard model={model('running', ALL)} actions={{ onAction }} />)
    fireEvent.click(screen.getByTestId('dc-workload-stop'))
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-workload-stop'))
    expect(onAction).toHaveBeenCalledWith('stop')
  })

  it('holds every action while a command is in flight', () => {
    render(
      <WorkloadCard
        model={model('running', ALL, { busy: true })}
        actions={{ onAction: vi.fn() }}
      />,
    )
    expect(screen.getByTestId('dc-workload-stop').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('dc-workload-restart').hasAttribute('disabled')).toBe(true)
  })

  it('draws the state dot with the uptime, and dashes for unreported gauges', () => {
    render(
      <WorkloadCard
        model={model('running', ALL, {
          uptime: '3d 4h',
          resources: { ...NO_RESOURCES, cpuPercent: 23.4 },
        })}
        actions={{ onAction: vi.fn() }}
      />,
    )
    expect(screen.getByTestId('dc-workload-status').textContent).toContain('3d 4h')
    expect(screen.getByTestId('dc-workload-dot').getAttribute('data-state')).toBe('running')
    expect(screen.getByTestId('dc-workload-gauge-cpu').textContent).toContain('23%')
    expect(screen.getByTestId('dc-workload-gauge-memory').textContent).toContain('—')
    expect(screen.getByTestId('dc-workload-gauge-memory').textContent).not.toContain('0%')
  })

  it('draws no gauges when the provider reports no resources', () => {
    render(
      <WorkloadCard
        model={model('running', { ...ALL, hasResources: false })}
        actions={{ onAction: vi.fn() }}
      />,
    )
    expect(screen.queryByTestId('dc-workload-gauge-cpu')).toBeNull()
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
