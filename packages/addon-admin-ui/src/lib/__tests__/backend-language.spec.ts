/** D863: the admin System sends its CURRENT i18n language, read per request. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSystem: vi.fn(),
  i18n: { language: 'it' },
}))

vi.mock('@camstack/sdk', () => ({ createSystem: mocks.createSystem }))
vi.mock('../connection-health', () => ({ reportSdkConnectionState: vi.fn() }))
vi.mock('../../i18n', () => ({ default: mocks.i18n }))
vi.mock('../admin-session', () => ({
  sessionKeeper: () => ({ refreshNow: async () => undefined, ensureFresh: async () => undefined }),
}))
vi.mock('../mount', () => ({ hubOrigin: () => 'https://hub.test' }))

describe('backend System language', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.createSystem.mockReset()
    mocks.createSystem.mockReturnValue({ close: vi.fn() })
    mocks.i18n.language = 'it'
    localStorage.clear()
  })

  it('hands the SDK a getLanguage that follows the live i18n language', async () => {
    const { getSystem } = await import('../backend')
    getSystem()
    const config: { getLanguage?: () => string } = mocks.createSystem.mock.calls[0]?.[0]
    expect(config.getLanguage?.()).toBe('it')
    mocks.i18n.language = 'en'
    expect(config.getLanguage?.()).toBe('en')
  })
})
