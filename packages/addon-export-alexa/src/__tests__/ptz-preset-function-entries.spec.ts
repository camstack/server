/**
 * A firmware FUNCTION sharing the PTZ preset namespace is not a preset Alexa
 * may recall.
 *
 * The dispensa camera (1438, Hikvision) lists its reserved band among its
 * presets — `94 Remote reboot`, `95 Call OSD menu`, `39 Day mode`, … — and the
 * `ptz.preset` ModeController offered every one of them, so "Alexa, set the
 * camera preset to Remote reboot" rebooted the camera.
 *
 * Recognised STRUCTURALLY, by the cap's `fn` field (the provider sets it from
 * the id band it knows is reserved), never by name: an operator may name their
 * own position "Day mode". `writable` is NOT the signal — ONVIF reports every
 * preset `writable: false` with `fn: null`, and those are ordinary positions.
 * `home` stays: it is a destination, the one function worth recalling (the
 * HomeKit export draws the same line).
 */
import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildEndpointsForExposedDevice, type DeviceBuildContext } from '../handlers/discovery.js'
import { handleSetMode } from '../handlers/ptz-preset.js'

interface Preset {
  readonly id: string
  readonly name: string
  readonly fn: string | null
  readonly writable: boolean
}

/** `ptz.getPresets` for device 1438, as the live hub returned it 2026-10-08. */
const DISPENSA_PRESETS: readonly Preset[] = [
  { id: '1', name: 'Credenza', fn: null, writable: true },
  { id: '2', name: 'Porta', fn: null, writable: true },
  { id: '3', name: 'Stanza', fn: null, writable: true },
  { id: '34', name: 'Back to origin', fn: 'home', writable: false },
  { id: '39', name: 'Day mode', fn: 'day-mode', writable: false },
  { id: '40', name: 'Night mode', fn: 'night-mode', writable: false },
  {
    id: '46',
    name: 'Day/Night Auto Mode',
    fn: 'day-night-auto',
    writable: false,
  },
  { id: '92', name: 'Set manual limits', fn: 'set-limits', writable: false },
  { id: '93', name: 'Save manual limits', fn: 'save-limits', writable: false },
  { id: '94', name: 'Remote reboot', fn: 'reboot', writable: false },
  { id: '95', name: 'Call OSD menu', fn: 'osd-menu', writable: false },
]

function harness(presets: readonly Preset[]) {
  const goToCalls: Array<{ deviceId: number; presetId: string }> = []
  // Documented test-stub boundary: discovery and SetMode read a handful of
  // methods of an API surface far too large to build by hand.
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    withTags: () => logger,
  } as unknown as IScopedLogger
  const api = {
    deviceManager: {
      getDevice: {
        query: async () => ({
          id: 1438,
          stableId: 'cam-1438',
          name: 'Dispensa',
          features: [],
          type: 'camera',
        }),
      },
      getBindings: {
        query: async () => ({ entries: [{ capName: 'ptz' }] }),
      },
      getChildren: { query: async () => [] },
    },
    ptz: {
      getPresets: { query: async () => presets },
      goToPreset: {
        mutate: async (input: { deviceId: number; presetId: string }) => {
          goToCalls.push(input)
        },
      },
    },
  } as unknown as AddonApi
  const ctx = { api } as unknown as AddonContext
  const discovery: DeviceBuildContext = {
    ctx,
    logger,
  }
  return { discovery, ptzPreset: { ctx, logger }, goToCalls }
}

async function presetModeValues(presets: readonly Preset[]): Promise<string[] | undefined> {
  const h = harness(presets)
  const endpoints = await buildEndpointsForExposedDevice(1438, h.discovery)
  const cap = endpoints[0]?.capabilities.find(
    (c) => c.interface === 'Alexa.ModeController' && c.instance === 'ptz.preset',
  )
  const modes = (cap?.configuration as { supportedModes?: Array<{ value: string }> } | undefined)
    ?.supportedModes
  return modes?.map((m) => m.value)
}

function setMode(h: ReturnType<typeof harness>, mode: string): Promise<unknown> {
  return handleSetMode(
    {
      namespace: 'Alexa.ModeController',
      name: 'SetMode',
      instance: 'ptz.preset',
      payloadVersion: '3',
      messageId: 'm',
      correlationToken: 'c',
    },
    { endpointId: '1438' },
    { mode },
    h.ptzPreset,
    { userId: 'u', username: 'u', scopes: [] },
  )
}

function errorType(response: unknown): string | undefined {
  return (response as { event?: { payload?: { type?: string } } }).event?.payload?.type
}

describe('alexa ptz.preset — firmware function entries are not recallable', () => {
  it('discovery offers stored positions and home, never a function', async () => {
    expect(await presetModeValues(DISPENSA_PRESETS)).toEqual([
      'ptz.preset.Credenza',
      'ptz.preset.Porta',
      'ptz.preset.Stanza',
      'ptz.preset.Back to origin',
    ])
  })

  it('recognises a function by `fn`, not by name or `writable`', async () => {
    const modes = await presetModeValues([
      // An operator's own position that happens to be named like a function.
      { id: '7', name: 'Remote reboot', fn: null, writable: true },
      // ONVIF: every preset unwritable, none a function.
      { id: '8', name: 'Gate', fn: null, writable: false },
      { id: '94', name: 'Reboot it', fn: 'reboot', writable: false },
    ])
    expect(modes).toEqual(['ptz.preset.Remote reboot', 'ptz.preset.Gate'])
  })

  it('drops the controller when only functions would make up the two modes', async () => {
    const modes = await presetModeValues([
      { id: '1', name: 'Credenza', fn: null, writable: true },
      { id: '94', name: 'Remote reboot', fn: 'reboot', writable: false },
    ])
    expect(modes).toBeUndefined()
  })

  it('SetMode refuses a function preset and never recalls it', async () => {
    const h = harness(DISPENSA_PRESETS)
    const response = await setMode(h, 'ptz.preset.Remote reboot')
    expect(errorType(response)).toBe('INVALID_DIRECTIVE')
    expect(h.goToCalls).toEqual([])
  })

  it('SetMode still recalls a stored position and home', async () => {
    const h = harness(DISPENSA_PRESETS)
    await setMode(h, 'ptz.preset.Porta')
    await setMode(h, 'ptz.preset.Back to origin')
    expect(h.goToCalls).toEqual([
      { deviceId: 1438, presetId: '2' },
      { deviceId: 1438, presetId: '34' },
    ])
  })

  it('SetMode resolves a name to the stored position when a function shares it', async () => {
    const h = harness([
      { id: '94', name: 'Remote reboot', fn: 'reboot', writable: false },
      { id: '7', name: 'Remote reboot', fn: null, writable: true },
    ])
    await setMode(h, 'ptz.preset.Remote reboot')
    expect(h.goToCalls).toEqual([{ deviceId: 1438, presetId: '7' }])
  })
})
