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
  applyQueryTransportOnline: vi.fn(),
  systems: [] as FakeSystem[],
}))

vi.mock('@camstack/sdk', () => ({
  createSystem: mocks.createSystem,
}))

vi.mock('../connection-health', () => ({
  reportSdkConnectionState: mocks.reportSdkConnectionState,
}))

vi.mock('../query-socket-online', () => ({
  applyQueryTransportOnline: mocks.applyQueryTransportOnline,
}))

// `backend` is re-imported after `vi.resetModules()` in every test. Its real
// i18n, session and mount modules are heavy; under a loaded full run that
// import outlived the 5 s budget, and a timed-out test kept emitting into the
// next one. None of them is what these tests judge.
vi.mock('../../i18n', () => ({ default: { language: 'en' } }))
vi.mock('../admin-session', () => ({
  sessionKeeper: () => ({ refreshNow: async () => undefined, ensureFresh: async () => undefined }),
}))
vi.mock('../mount', () => ({ hubOrigin: () => 'https://hub.test' }))

describe('backend System ownership', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.createSystem.mockReset()
    mocks.reportSdkConnectionState.mockReset()
    mocks.applyQueryTransportOnline.mockReset()
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
    expect(mocks.applyQueryTransportOnline.mock.calls).toEqual([['connected'], ['connected']])
  })

  it('continues forwarding state from the active socket', async () => {
    const { getSystem } = await import('../backend')

    getSystem()
    const active = mocks.systems[0]!
    active.emit('connected')
    active.emit('disconnected')

    expect(mocks.reportSdkConnectionState.mock.calls).toEqual([['connected'], ['disconnected']])
    expect(mocks.applyQueryTransportOnline.mock.calls).toEqual([['connected'], ['disconnected']])
  })
})
