/**
 * The stream-broker's persisted RTSP restream state (D870): the tokens of a
 * camera are ONE keychain-held per-device setting (`rtspTokens`, JSON text of
 * `{ camStreamId: token }`), while `rtspEnabled` is still a key of the
 * `addon-settings` / `root` blob.
 *
 * Behaviour contract pinned here:
 *  - a populated store hydrates into the exact same Maps the blob produced;
 *  - an empty store keeps first-boot silence (no loader call, no log);
 *  - a corrupt or still-locked token value costs that camera, not every camera;
 *  - a store that cannot be asked THROWS, and the writer refuses until a load
 *    has answered - a token set rebuilt from a failed read would turn every
 *    external NVR URL into a 404;
 *  - `rtspEnabled` hydrates independently of anything the token store does.
 */
import { describe, it, expect, vi } from 'vitest'
import { createDurableState, type DurableState, type IScopedLogger } from '@camstack/types'
import { hydratePersistedRtspState } from '../addon.js'
import { RtspEnabledSchema, type RtspEnabledBlob } from '../stream-broker/stream-broker-manager.js'
import { mergeRtspTokens, RTSP_TOKENS_KEY, rtspTokensMirror } from '../broker-device-state.js'
import {
  makeFakeBrokerDeviceSettings,
  type FakeBrokerDeviceSettings,
} from './fake-broker-device-settings.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  // Documented type boundary: the mirror only ever calls `warn`.
  return logger as unknown as IScopedLogger
}

interface Fixture {
  readonly settings: FakeBrokerDeviceSettings
  readonly tokensMirror: ReturnType<typeof rtspTokensMirror>
  readonly enabledState: DurableState<RtspEnabledBlob>
}

function makeStates(enabled: Record<string, boolean> = {}): Fixture {
  const settings = makeFakeBrokerDeviceSettings()
  let blob: Record<string, unknown> = { rtspEnabled: { ...enabled } }
  return {
    settings,
    tokensMirror: rtspTokensMirror(settings, silentLogger()),
    enabledState: createDurableState<RtspEnabledBlob>({
      key: 'rtspEnabled',
      schema: RtspEnabledSchema,
      fallback: {},
      read: async () => ({ ...blob }),
      write: async (patch) => {
        blob = { ...blob, ...patch }
      },
    }),
  }
}

function seedTokens(
  settings: FakeBrokerDeviceSettings,
  deviceId: number,
  tokens: Record<string, string>,
): void {
  settings.rows.set(deviceId, { [RTSP_TOKENS_KEY]: JSON.stringify(tokens) })
}

function makeLogger(): { info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn() }
}

describe('stream-broker - persisted RTSP state on per-device settings', () => {
  it('hydrates seeded tokens + enabled states into the same Maps as the blob did', async () => {
    const { settings, tokensMirror, enabledState } = makeStates({
      '7/native:main': true,
      '9/native:sub': false,
    })
    seedTokens(settings, 7, { 'native:main': 'tok-a' })
    seedTokens(settings, 9, { 'native:sub': 'tok-b' })
    const loadTokens = vi.fn()
    const loadEnabled = vi.fn()

    await hydratePersistedRtspState({
      tokensMirror,
      enabledState,
      loadTokens,
      loadEnabled,
      logger: makeLogger(),
    })

    expect(loadTokens.mock.calls[0]![0]).toEqual(
      new Map([
        ['7/native:main', 'tok-a'],
        ['9/native:sub', 'tok-b'],
      ]),
    )
    expect(loadEnabled.mock.calls[0]![0]).toEqual(
      new Map([
        ['7/native:main', true],
        ['9/native:sub', false],
      ]),
    )
  })

  it('keeps first-boot silence: an empty store and an absent key call no loader', async () => {
    const { tokensMirror, enabledState } = makeStates()
    const loadTokens = vi.fn()
    const loadEnabled = vi.fn()

    await hydratePersistedRtspState({
      tokensMirror,
      enabledState,
      loadTokens,
      loadEnabled,
      logger: makeLogger(),
    })

    expect(loadTokens).not.toHaveBeenCalled()
    expect(loadEnabled).not.toHaveBeenCalled()
  })

  it('a corrupt token value costs THAT camera - not every external URL', async () => {
    const { settings, tokensMirror, enabledState } = makeStates()
    seedTokens(settings, 7, { 'native:main': 'tok-a' })
    settings.rows.set(11, { [RTSP_TOKENS_KEY]: 'not json' })
    const loadTokens = vi.fn()

    await hydratePersistedRtspState({
      tokensMirror,
      enabledState,
      loadTokens,
      loadEnabled: vi.fn(),
      logger: makeLogger(),
    })

    expect(loadTokens.mock.calls[0]![0]).toEqual(new Map([['7/native:main', 'tok-a']]))
  })

  it('LOCKED KEYCHAIN: the other cameras load, the held one is BLOCKED and nothing is written for it', async () => {
    const { settings, tokensMirror, enabledState } = makeStates()
    seedTokens(settings, 7, { 'native:main': 'tok-a' })
    // The marker the locked keychain did not resolve.
    const marker = { $secret: 'secret://stream-broker/device/9/rtspTokens', v: 1 }
    settings.rows.set(9, { [RTSP_TOKENS_KEY]: marker })
    const loadTokens = vi.fn()

    await hydratePersistedRtspState({
      tokensMirror,
      enabledState,
      loadTokens,
      loadEnabled: vi.fn(),
      logger: makeLogger(),
    })
    // every other camera is served with its stored token
    expect(loadTokens.mock.calls[0]![0]).toEqual(new Map([['7/native:main', 'tok-a']]))
    expect([...tokensMirror.heldDevices().keys()]).toEqual([9])

    // The broker minting new tokens for the held camera cannot overwrite the held ones…
    await tokensMirror.merge(
      mergeRtspTokens(
        tokensMirror,
        new Map([
          ['9/native:main', 'minted'],
          ['7/native:sub', 'tok-b'],
        ]),
      ),
    )
    expect(settings.rows.get(9)).toEqual({ [RTSP_TOKENS_KEY]: marker })
    // …while an unaffected camera is still written.
    expect(settings.writes).toEqual([7])
  })

  it('a store that cannot be asked THROWS, and the writer then refuses', async () => {
    const { settings, tokensMirror, enabledState } = makeStates()
    seedTokens(settings, 7, { 'native:main': 'tok-a' })
    settings.failReads(new Error('store down'))

    await expect(
      hydratePersistedRtspState({
        tokensMirror,
        enabledState,
        loadTokens: vi.fn(),
        loadEnabled: vi.fn(),
        logger: makeLogger(),
      }),
    ).rejects.toThrow('store down')

    settings.failReads(null)
    await expect(
      tokensMirror.merge(mergeRtspTokens(tokensMirror, new Map([['7/native:sub', 'tok-new']]))),
    ).rejects.toThrow(/never loaded/)
    // The unloaded writer left the camera's existing tokens alone.
    expect(settings.rows.get(7)).toEqual({
      [RTSP_TOKENS_KEY]: JSON.stringify({ 'native:main': 'tok-a' }),
    })
  })

  it('merges a new stream token into the camera without losing its other streams', async () => {
    const { settings, tokensMirror } = makeStates()
    seedTokens(settings, 7, { 'native:main': 'tok-a' })
    await tokensMirror.load()

    await tokensMirror.merge(
      mergeRtspTokens(
        tokensMirror,
        new Map([
          ['7/native:sub', 'tok-b'],
          ['9/native:main', 'tok-c'],
        ]),
      ),
    )

    expect(settings.rows.get(7)).toEqual({
      [RTSP_TOKENS_KEY]: JSON.stringify({ 'native:main': 'tok-a', 'native:sub': 'tok-b' }),
    })
    expect(settings.rows.get(9)).toEqual({
      [RTSP_TOKENS_KEY]: JSON.stringify({ 'native:main': 'tok-c' }),
    })
  })

  it('writes only the cameras whose tokens changed', async () => {
    const { settings, tokensMirror } = makeStates()
    seedTokens(settings, 7, { 'native:main': 'tok-a' })
    await tokensMirror.load()

    await tokensMirror.merge(
      mergeRtspTokens(
        tokensMirror,
        new Map([
          ['7/native:main', 'tok-a'],
          ['9/native:main', 'tok-c'],
        ]),
      ),
    )

    expect(settings.writes).toEqual([9])
  })

  it('logs the hydration counts (same operator-facing signal as before)', async () => {
    const { settings, tokensMirror, enabledState } = makeStates({ a: true, b: false })
    seedTokens(settings, 7, { a: 't' })
    const logger = makeLogger()

    await hydratePersistedRtspState({
      tokensMirror,
      enabledState,
      loadTokens: vi.fn(),
      loadEnabled: vi.fn(),
      logger,
    })

    expect(logger.info).toHaveBeenCalledWith(
      'Loaded persisted RTSP tokens',
      expect.objectContaining({ meta: { tokenCount: 1 } }),
    )
    expect(logger.info).toHaveBeenCalledWith(
      'Loaded persisted RTSP enabled states',
      expect.objectContaining({ meta: { stateCount: 2 } }),
    )
  })
})
