import { beforeEach, describe, expect, it, vi } from 'vitest'

type ConnectionState = 'connected' | 'disconnected' | 'connecting'
type ConnectionCallback = (state: ConnectionState) => void

interface FakeSystem {
  readonly close: ReturnType<typeof vi.fn>
  readonly emit: ConnectionCallback
}

const mocks = vi.hoisted(() => ({
  createSystem: vi.fn(),
  reportSdkConnectionState: vi.fn(),
  systems: [] as FakeSystem[],
}))

vi.mock('@camstack/sdk', () => ({
  createSystem: mocks.createSystem,
}))

vi.mock('../connection-health', () => ({
  reportSdkConnectionState: mocks.reportSdkConnectionState,
}))

describe('backend System ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.createSystem.mockReset()
    mocks.reportSdkConnectionState.mockReset()
    mocks.systems.length = 0
    localStorage.clear()

    mocks.createSystem.mockImplementation(
      (config: { readonly onConnectionChange?: ConnectionCallback }) => {
        const fake: FakeSystem = {
          close: vi.fn(),
          emit: (state) => config.onConnectionChange?.(state),
        }
        mocks.systems.push(fake)
        return fake
      },
    )
  })

  it('ignores a delayed close callback from a retired socket', async () => {
    const { getSystem, resetSystem } = await import('../backend')

    getSystem()
    const first = mocks.systems[0]!
    first.emit('connected')

    resetSystem()
    getSystem()
    const second = mocks.systems[1]!
    second.emit('connected')
    first.emit('disconnected')

    expect(first.close).toHaveBeenCalledOnce()
    expect(mocks.reportSdkConnectionState.mock.calls).toEqual([['connected'], ['connected']])
  })

  it('continues forwarding state from the active socket', async () => {
    const { getSystem } = await import('../backend')

    getSystem()
    const active = mocks.systems[0]!
    active.emit('connected')
    active.emit('disconnected')

    expect(mocks.reportSdkConnectionState.mock.calls).toEqual([['connected'], ['disconnected']])
  })
})
