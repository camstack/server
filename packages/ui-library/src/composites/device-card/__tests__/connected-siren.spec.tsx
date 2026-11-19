// @vitest-environment jsdom
/**
 * The connected siren: pending until a slice answers, the served state only,
 * one command per tap (the one-shot claim) and a held button while it flies.
 */
import type { SirenOptions, SirenRuntimeState, SwitchStatus } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedSirenCard } from '../connected/ConnectedSirenCard'

const never = (): Promise<never> => new Promise(() => undefined)

const OPTIONS: SirenOptions = {
  allowedSeconds: [10, 30, 60],
  rangeSeconds: null,
  defaultSeconds: 30,
  allowedPlays: null,
  rangePlays: null,
  defaultPlays: null,
  unit: 'seconds',
  secondsPerPlay: null,
  source: 'camera',
  fetchedAt: 1,
}

const hub = vi.hoisted(() => ({
  withSiren: true,
  switchSlice: undefined as SwitchStatus | undefined,
  sirenSlice: undefined as SirenRuntimeState | undefined,
  trigger: vi.fn(),
  stop: vi.fn(),
  getOptions: vi.fn(),
  setState: vi.fn(),
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    switch: { setState: hub.setState },
    ...(hub.withSiren
      ? {
          siren: {
            trigger: hub.trigger,
            stop: hub.stop,
            getOptions: hub.getOptions,
          },
        }
      : {}),
    state: {
      switch: hub.switchSlice,
      siren: hub.sirenSlice,
    },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => {
    const common = plugFixtures(0)[0]?.model.common
    if (common === undefined) throw new Error('no plug fixture')
    return {
      common,
      actions: {},
      deviceType: 'siren',
      role: 'siren',
      features: [],
      implements: () => true,
      fail: () => undefined,
      succeed: () => undefined,
    }
  },
}))

function mount(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const tree: ReactElement = (
    <QueryClientProvider client={client}>
      <ConnectedSirenCard deviceId={591} />
    </QueryClientProvider>
  )
  render(tree)
}

const silent: SirenRuntimeState = {
  active: false,
  activeUntil: null,
  durationSeconds: null,
  plays: null,
  activeUntilEstimated: false,
  lastTriggeredAt: 0,
  lastFetchedAt: 1,
}

beforeEach(() => {
  hub.withSiren = true
  hub.switchSlice = { on: false, lastChangedAt: 0 }
  hub.sirenSlice = silent
  for (const spy of [hub.trigger, hub.stop, hub.setState]) {
    spy.mockReset()
    spy.mockImplementation(never)
  }
  hub.getOptions.mockReset()
  hub.getOptions.mockResolvedValue(OPTIONS)
})
afterEach(cleanup)

describe('ConnectedSirenCard', () => {
  it('is pending while the siren slice has not answered, never silent', () => {
    hub.sirenSlice = undefined
    mount()
    expect(screen.getByTestId('dc-card-pending')).toBeTruthy()
    expect(screen.queryByText('Silent')).toBeNull()
  })

  it('is pending while a switch-only siren has not answered', () => {
    hub.withSiren = false
    hub.switchSlice = undefined
    mount()
    expect(screen.getByTestId('dc-card-pending')).toBeTruthy()
  })

  it('reads sounding from the siren slice, not the switch', () => {
    hub.sirenSlice = {
      ...silent,
      active: true,
      activeUntil: Date.now() + 20_000,
      durationSeconds: 30,
    }
    mount()
    expect(screen.getByText('Sounding')).toBeTruthy()
    expect(screen.getByTestId('dc-siren-stop')).toBeTruthy()
  })

  it('triggers once for a double tap, and holds the button while it flies', () => {
    mount()
    const sound = screen.getByTestId('dc-siren-sound')
    fireEvent.click(sound)
    act(() => {
      // Confirm twice in one tick: the second lands before the re-render.
      sound.click()
      sound.click()
    })
    expect(hub.trigger).toHaveBeenCalledTimes(1)
    expect(hub.trigger).toHaveBeenCalledWith({})
    expect(screen.getByTestId('dc-siren-sound').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Silent')).toBeTruthy()
  })

  it('stops once for a double tap, and holds Stop while it flies', () => {
    hub.sirenSlice = {
      ...silent,
      active: true,
      activeUntil: Date.now() + 20_000,
      durationSeconds: 30,
    }
    mount()
    const stop = screen.getByTestId('dc-siren-stop')
    act(() => {
      stop.click()
      stop.click()
    })
    expect(hub.stop).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('dc-siren-stop').hasAttribute('disabled')).toBe(true)
    // Still sounding until the served slice says otherwise.
    expect(screen.getByText('Sounding')).toBeTruthy()
  })

  it('sends the picked duration from the options the siren declared', async () => {
    mount()
    const chip = await screen.findByTestId('dc-siren-seconds')
    expect(chip.textContent).toBe('Default duration')
    expect(screen.queryByTestId('dc-siren-plays')).toBeNull()
    expect(screen.queryByTestId('dc-siren-options-unavailable')).toBeNull()
  })

  it('marks the options unavailable when getOptions fails, unlike a siren with one value', async () => {
    hub.getOptions.mockRejectedValue(new Error('camera unreachable'))
    mount()
    expect(await screen.findByTestId('dc-siren-options-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('dc-siren-seconds')).toBeNull()
    cleanup()
    hub.getOptions.mockResolvedValue({ ...OPTIONS, allowedSeconds: [30] })
    mount()
    await vi.waitFor(() => expect(hub.getOptions).toHaveBeenCalled())
    expect(screen.queryByTestId('dc-siren-options-unavailable')).toBeNull()
    expect(screen.queryByTestId('dc-siren-seconds')).toBeNull()
  })

  it('sounds a switch-only siren through its switch, with no chips', () => {
    hub.withSiren = false
    mount()
    const sound = screen.getByTestId('dc-siren-sound')
    fireEvent.click(sound)
    fireEvent.click(sound)
    expect(hub.setState).toHaveBeenCalledWith({ on: true })
    expect(screen.queryByTestId('dc-siren-seconds')).toBeNull()
    expect(hub.getOptions).not.toHaveBeenCalled()
  })
})
