// @vitest-environment jsdom
/**
 * The connected workload card and its list row against a fake hub. An action
 * is one shot (D1061): a double tap sends it once, and every action waits
 * while it is in flight. The row carries the hero's state dot and uptime.
 */
import {
  DeviceType,
  type WorkloadOptions,
  type WorkloadResources,
  type WorkloadStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkloadInlineControl } from '../../device-controls/workload-control'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedWorkloadCard } from '../connected/ConnectedWorkloadCard'

interface WorkloadHub {
  cap: {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    restart: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    forceStop: ReturnType<typeof vi.fn>
  }
  slice: WorkloadStatus | null
  options: WorkloadOptions
}

const hub = vi.hoisted(
  (): WorkloadHub => ({
    cap: {
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      forceStop: vi.fn(),
    },
    slice: null,
    options: {
      supportsStart: true,
      supportsStop: true,
      supportsRestart: true,
      supportsPause: false,
      supportsForceStop: false,
      hasResources: true,
      hasPorts: false,
      hasAddresses: false,
      hasAutostart: false,
      hasUpdateCheck: false,
    },
  }),
)

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../generated/system-hooks', () => ({
  useWorkloadGetOptions: () => ({ data: hub.options }),
  useDeviceManagerGetDevice: () => ({ data: undefined }),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    workload: hub.slice === null ? undefined : hub.cap,
    state: { workload: hub.slice ?? undefined },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => ({
    cap: hub.slice === null ? undefined : hub.cap,
    slice: hub.slice ?? undefined,
    available: hub.slice !== null,
  }),
}))
vi.mock('../connected/use-card-common', async () => {
  const { useCommandNotice } = await import('../connected/use-command-notice')
  return {
    useCardCommon: () => {
      const { notice, fail, succeed } = useCommandNotice()
      const common = plugFixtures(0)[0]?.model.common
      if (common === undefined) throw new Error('no plug fixture')
      return {
        common: {
          ...common,
          power: null,
          consumables: null,
          supply: null,
          remote: null,
          battery: null,
          notice,
        },
        actions: {},
        deviceType: DeviceType.Workload,
        role: 'vm',
        features: [],
        implements: (): boolean => true,
        fail,
        succeed,
      }
    },
  }
})

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

function status(patch: Partial<WorkloadStatus>): WorkloadStatus {
  return {
    state: 'stopped',
    since: null,
    hostDeviceId: null,
    image: null,
    os: null,
    version: null,
    autostart: null,
    resources: NO_RESOURCES,
    ports: [],
    addresses: [],
    updateAvailable: null,
    lastFetchedAt: 0,
    ...patch,
  }
}

beforeEach(() => {
  for (const fn of Object.values(hub.cap)) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.slice = null
})
afterEach(cleanup)

describe('the connected workload card', () => {
  it('sends a double-tapped start once, and holds every action while it is in flight (D1061)', async () => {
    hub.slice = status({ state: 'stopped' })
    hub.cap.start.mockReturnValueOnce(new Promise(() => {}))
    render(<ConnectedWorkloadCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-workload-start'))
    fireEvent.click(screen.getByTestId('dc-workload-start'))
    await vi.waitFor(() => expect(hub.cap.start).toHaveBeenCalledTimes(1))
    expect((screen.getByTestId('dc-workload-start') as HTMLButtonElement).disabled).toBe(true)
    expect(hub.cap.start).toHaveBeenCalledTimes(1)
  })

  it('shows the served state after a command, never the one it asked for', async () => {
    hub.slice = status({ state: 'stopped' })
    render(<ConnectedWorkloadCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-workload-start'))
    await vi.waitFor(() => expect(hub.cap.start).toHaveBeenCalledTimes(1))
    // The hub still serves "stopped": the card still offers start, not stop.
    expect(screen.getByTestId('dc-workload-start')).toBeTruthy()
    expect(screen.queryByTestId('dc-workload-stop')).toBeNull()
  })
})

describe('the workload list row', () => {
  it('carries the state dot and how long it has been in that state', () => {
    hub.slice = status({ state: 'running', since: Date.now() - (3 * 24 + 4) * 3_600_000 })
    render(<WorkloadInlineControl trpc={{} as never} deviceId={1} features={[]} />)
    expect(screen.getByTestId('workload-inline-dot').getAttribute('data-state')).toBe('running')
    expect(screen.getByTestId('workload-inline').textContent).toContain('Running')
    expect(screen.getByTestId('workload-inline').textContent).toContain('3d 4h')
  })

  it('draws an unknown state hollow, with no uptime', () => {
    hub.slice = status({ state: null, since: null })
    render(<WorkloadInlineControl trpc={{} as never} deviceId={1} features={[]} />)
    expect(screen.getByTestId('workload-inline-dot').getAttribute('data-state')).toBe('unknown')
    expect(screen.getByTestId('workload-inline').textContent).toBe('State unknown')
  })
})
