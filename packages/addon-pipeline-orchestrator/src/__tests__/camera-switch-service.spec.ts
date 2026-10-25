/**
 * `CameraSwitchService` — the DEPRECATED per-camera function switch group, and
 * the shared authority read it is now a shim over (D113).
 *
 * The group ADDS NO STATE. Every assertion here is therefore about routing:
 * did the switch write the authority that already owned the function, and did
 * it leave everything else alone? A group that invented its own map would pass
 * a "the boolean persisted" test and still be broken.
 *
 * The load-bearing ones:
 *  - recording flips `enabled` and leaves `bands` BYTE-IDENTICAL. Clearing
 *    bands to express "off" destroys the operator's authored schedule, and
 *    turning the camera back on would then silently record nothing;
 *  - a switch this camera does not offer is REJECTED, not persisted — a write
 *    nothing reads is the failure the group exists to remove;
 *  - an unreadable source never renders a control defaulted to "on".
 */
import type { RecordingConfig } from '@camstack/types'
import { composeSwitchedOff } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraSwitchService } from '../camera-switch-service.js'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { readSwitchAuthorities } from '../switch-authorities.js'

interface Call {
  readonly method: string
  readonly input: unknown
}

const BANDS: RecordingConfig['bands'] = [
  { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', mode: 'continuous' },
  { days: [], start: '18:00', end: '08:00', mode: 'events', triggers: { motion: true } },
]

interface FakeWorld {
  deviceType: string
  deviceDisabled: boolean
  bindable: Array<{ capName: string; wrappers: string[] }>
  boundWrappers: Map<string, string>
  /**
   * Device-NATIVE caps bound to this camera. Separate from `boundWrappers`
   * because that is exactly how the hub reports them: `kind: 'native'`, no
   * wrapper, and therefore absent from `listBindableCapsForDeviceType`'s
   * wrapper-bearing rows. A fake that merged the two would let a broken
   * availability derivation pass.
   */
  nativeCaps: Set<string>
  recording: RecordingConfig | null
  mutedDeviceIds: number[]
  /** What the CAMERA holds. There is no server-side copy — that is the point. */
  cameraAudioEnabled: boolean
  supportsAudioMute: boolean
  /** Zones DRAWN on the camera. Zero is what every camera in the live
   *  deployment reported on 2026-08-07 — the switch is offered, with a
   *  warning; only an UNREADABLE count withholds it. */
  cameraMaskRegions: number
  cameraMaskEnabled: boolean
  /** `maxRegions: 0` — the honest Reolink answer for a model that cannot. */
  cameraMaskMaxRegions: number
  failGetBindings: boolean
  failRecording: boolean
  failMutes: boolean
  failPrivacyOptions: boolean
  failPrivacyStatus: boolean
  /**
   * The BROKER's per-device audio policy (D83). A separate field from
   * `cameraAudioEnabled` on purpose: these are two stores on two machines,
   * and a fake that merged them would let a service reading the wrong one
   * pass.
   */
  brokerAudioMuted: boolean
  failBrokerAudio: boolean
  /**
   * Sources that answer eventually but not soon. A CAMERA probe is the real
   * shape here: on 2026-08-08 `privacyMask.getStatus` took 3.1–3.6s on device
   * 614, every call, while every other source answered in under 15ms — so
   * "slow" has to be a separate fake knob from "failed". A source that hangs
   * FOREVER is the same defect one order of magnitude further along.
   */
  slowMs: Map<string, number>
}

function makeWorld(): FakeWorld {
  return {
    deviceType: 'camera',
    deviceDisabled: false,
    bindable: [
      { capName: 'detection-pipeline', wrappers: ['detection-pipeline'] },
      { capName: 'audio-analysis', wrappers: ['audio-analyzer'] },
      { capName: 'pipeline-analytics', wrappers: ['post-analysis'] },
      { capName: 'motion-detection', wrappers: ['motion-wasm'] },
      // The shape that matters: a device-native cap IS listed for the type,
      // with NO wrappers. If the switch derived availability from this row it
      // would drop the microphone on every camera that has one.
      { capName: 'privacy-mask', wrappers: [] },
    ],
    boundWrappers: new Map([
      ['detection-pipeline', 'detection-pipeline'],
      ['audio-analysis', 'audio-analyzer'],
      ['pipeline-analytics', 'post-analysis'],
      ['motion-detection', 'motion-wasm'],
    ]),
    nativeCaps: new Set(['privacy-mask']),
    recording: { enabled: true, bands: BANDS },
    mutedDeviceIds: [],
    cameraAudioEnabled: true,
    supportsAudioMute: true,
    cameraMaskRegions: 2,
    cameraMaskEnabled: false,
    cameraMaskMaxRegions: 4,
    failGetBindings: false,
    failRecording: false,
    failMutes: false,
    failPrivacyOptions: false,
    failPrivacyStatus: false,
    brokerAudioMuted: false,
    failBrokerAudio: false,
    slowMs: new Map(),
  }
}

function makeApi(world: FakeWorld, calls: Call[]): never {
  const q = <T>(method: string, fn: (input: unknown) => T) => ({
    query: async (input: unknown): Promise<T> => {
      calls.push({ method, input })
      const delay = world.slowMs.get(method)
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay))
      return fn(input)
    },
  })
  const m = <T>(method: string, fn: (input: unknown) => T) => ({
    mutate: async (input: unknown): Promise<T> => {
      calls.push({ method, input })
      return fn(input)
    },
  })
  const api = {
    deviceManager: {
      getDevice: q('getDevice', () => ({
        id: 101,
        type: world.deviceType,
        disabled: world.deviceDisabled,
      })),
      listBindableCapsForDeviceType: q('listBindableCapsForDeviceType', () => world.bindable),
      getBindings: q('getBindings', () => {
        if (world.failGetBindings) throw new Error('bindings down')
        return {
          deviceId: 101,
          entries: [
            ...[...world.boundWrappers].map(([capName, providerAddonId]) => ({
              capName,
              kind: 'wrapped' as const,
              providerAddonId,
              providerNodeId: 'hub',
              nativeAddonId: '',
            })),
            ...[...world.nativeCaps].map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: '',
              providerNodeId: 'hub',
              nativeAddonId: 'provider-hikvision',
            })),
          ],
        }
      }),
      setWrapperActive: m('setWrapperActive', (input) => {
        const { capName, wrapperAddonId, active } = input as {
          capName: string
          wrapperAddonId: string
          active: boolean
        }
        if (active) world.boundWrappers.set(capName, wrapperAddonId)
        else world.boundWrappers.delete(capName)
      }),
      setDisabled: m('setDisabled', (input) => {
        world.deviceDisabled = (input as { disabled: boolean }).disabled
      }),
    },
    recordingArchive: {
      getDeviceConfig: q('getDeviceConfig', () => {
        if (world.failRecording) throw new Error('recorder down')
        return world.recording
      }),
      setDeviceConfig: m('setDeviceConfig', (input) => {
        const { config } = input as { config: RecordingConfig }
        world.recording = config
        return config
      }),
    },
    privacyMask: {
      getOptions: q('privacyMask.getOptions', () => {
        if (world.failPrivacyOptions) throw new Error('camera unreachable')
        return {
          maxRegions: world.cameraMaskMaxRegions,
          supportedShapes: world.cameraMaskMaxRegions > 0 ? ['rect'] : [],
          supportsAudioMute: world.supportsAudioMute,
        }
      }),
      getStatus: q('privacyMask.getStatus', () => {
        if (world.failPrivacyStatus) throw new Error('camera unreachable')
        return {
          enabled: world.cameraMaskEnabled,
          regions: Array.from({ length: world.cameraMaskRegions }, (_v, id) => ({
            id,
            enabled: true,
            shape: { kind: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          })),
          audioEnabled: world.supportsAudioMute ? world.cameraAudioEnabled : null,
        }
      }),
      setAudioEnabled: m('privacyMask.setAudioEnabled', (input) => {
        const { enabled } = input as { enabled: boolean }
        world.cameraAudioEnabled = enabled
      }),
      setMask: m('privacyMask.setMask', (input) => {
        const { patch } = input as { patch: { enabled?: boolean; regions?: unknown[] } }
        if (patch.enabled !== undefined) world.cameraMaskEnabled = patch.enabled
        // The fake HONOURS a regions write so a switch that sent one would be
        // caught by the assertion that the drawing survives.
        if (patch.regions !== undefined) world.cameraMaskRegions = patch.regions.length
      }),
    },
    streamBroker: {
      getDeviceAudioMute: q('streamBroker.getDeviceAudioMute', () => {
        if (world.failBrokerAudio) throw new Error('broker node unreachable')
        return { muted: world.brokerAudioMuted, appliedBrokers: world.brokerAudioMuted ? 2 : 0 }
      }),
      setDeviceAudioMute: m('streamBroker.setDeviceAudioMute', (input) => {
        const { muted } = input as { muted: boolean }
        world.brokerAudioMuted = muted
        return { muted, appliedBrokers: muted ? 2 : 0 }
      }),
    },
    notificationRules: {
      listDeviceMutes: q('listDeviceMutes', () => {
        if (world.failMutes) throw new Error('nc down')
        return { mutedDeviceIds: world.mutedDeviceIds }
      }),
      setDeviceMuted: m('setDeviceMuted', (input) => {
        const { deviceId, muted } = input as { deviceId: number; muted: boolean }
        world.mutedDeviceIds = muted
          ? [...new Set([...world.mutedDeviceIds, deviceId])]
          : world.mutedDeviceIds.filter((id) => id !== deviceId)
        return { success: true as const }
      }),
    },
  }
  // Documented type boundary: the fake implements exactly the `AddonApi`
  // members the service calls; the generated type is a 900-router union.
  return api as never
}

const silentLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  child: (): unknown => silentLogger,
}

/** One `logger.warn` call, so a test can assert the line AND its `deviceId` tag. */
interface Warning {
  readonly message: string
  readonly tags: Record<string, unknown> | undefined
  readonly meta: Record<string, unknown> | undefined
}

describe('CameraSwitchService', () => {
  let world: FakeWorld
  let calls: Call[]
  let warnings: Warning[]
  let service: CameraSwitchService
  let warnSampler: RepeatWarnSampler
  let switchedOffFor: (deviceId: number) => Promise<readonly string[]>

  beforeEach(() => {
    world = makeWorld()
    calls = []
    warnings = []
    const logger = {
      ...silentLogger,
      warn: (message: string, ctx?: unknown): void => {
        const rec: Record<string, unknown> = ctx === undefined ? {} : { ...(ctx as object) }
        const tags = rec['tags']
        const meta = rec['meta']
        warnings.push({
          message,
          tags: typeof tags === 'object' && tags !== null ? { ...tags } : undefined,
          meta: typeof meta === 'object' && meta !== null ? { ...meta } : undefined,
        })
      },
    }
    // ONE sampler per test, shared by both read paths exactly as
    // `orchestrator-bootstrap` shares it in production — two would each let the
    // same flood through. There is no cache beside it: the privacy pair is a
    // read-through to the provider, which owns its own freshness (D221).
    warnSampler = new RepeatWarnSampler()
    service = new CameraSwitchService({
      api: () => makeApi(world, calls),
      logger: logger as never,
      assignSource: () => 'agent-little',
      warnSampler,
    })
    // The BADGE path, exercised against the same fake world. `CameraStatus`
    // reaches the authorities through `readSwitchAuthorities` + the pure
    // `composeSwitchedOff`, with no switch group in the middle (D113) — so the
    // assertions that used to go through `switchedOffIdsFor` have to follow it
    // there, or the shim's deletion silently takes them with it.
    switchedOffFor = async (deviceId: number): Promise<readonly string[]> =>
      composeSwitchedOff(
        (
          await readSwitchAuthorities(makeApi(world, calls), deviceId, {
            logger: logger as never,
            assignSource: () => 'agent-little',
            warnSampler,
          })
        ).derivation,
      ).switchedOff
  })

  const get = async (): Promise<Awaited<ReturnType<CameraSwitchService['getCameraSwitches']>>> =>
    service.getCameraSwitches(101)

  const switchOf = async (id: string) => {
    const group = await get()
    const found = group.switches.find((s) => s.id === id)
    if (!found) throw new Error(`no switch ${id}`)
    return found
  }

  // ── read ────────────────────────────────────────────────────────────

  it('composes every switch for a healthy camera, all on', async () => {
    const group = await get()
    expect(group.deviceId).toBe(101)
    expect(group.switches.map((s) => s.id)).toEqual([
      'stream-broker',
      'object-detection',
      'privacy-mask',
      'device-audio',
      'broker-audio',
      'audio-analysis',
      // Added to the catalog on 2026-09-19: detection keeps running and the
      // live boxes keep moving, what stops is the WRITING — a camera that
      // looks busy with an empty timeline was the state an operator could not
      // otherwise explain.
      'event-saving',
      'recording',
      'notifications',
    ])
    expect(group.switches.every((s) => s.available)).toBe(true)
    // Every FUNCTION on. `privacy-mask` is the one row whose ON means the
    // opposite — video obscured — so a healthy camera has it off.
    expect(group.switches.filter((s) => s.id !== 'privacy-mask').every((s) => s.enabled)).toBe(true)
    expect(group.switches.find((s) => s.id === 'privacy-mask')?.enabled).toBe(false)
  })

  /**
   * The two things the group derives from bindings — which wrappers are ACTIVE
   * (the read) and which addon provides each cap (the write target) — must come
   * from ONE answer.
   *
   * Two round trips are not merely wasteful. They are two reads that can
   * disagree: a rebind landing between them yields a group whose `enabled` was
   * computed from one snapshot while `setCameraSwitch` writes the addon named by
   * another. `CameraStatus` pays this fan-out once PER CAMERA, so the waste is
   * also multiplied by the fleet.
   */
  it('asks getBindings exactly ONCE per read — the active set and the write target are one answer', async () => {
    await get()
    expect(calls.filter((c) => c.method === 'getBindings')).toHaveLength(1)
  })

  it('offers NO audio switch when no wrapper provides audio-analysis', async () => {
    world.bindable = world.bindable.filter((b) => b.capName !== 'audio-analysis')
    world.boundWrappers.delete('audio-analysis')
    expect(await switchOf('audio-analysis')).toMatchObject({
      available: false,
      unavailableReason: 'no-provider',
    })
  })

  it('a cap listed with NO wrappers is not a switch — nothing could write it', async () => {
    world.bindable = world.bindable.map((b) =>
      b.capName === 'audio-analysis' ? { ...b, wrappers: [] } : b,
    )
    expect(await switchOf('audio-analysis')).toMatchObject({
      available: false,
      unavailableReason: 'no-provider',
    })
  })

  it('an unreachable recorder yields available:false, never a control defaulted to on', async () => {
    world.failRecording = true
    expect(await switchOf('recording')).toMatchObject({
      available: false,
      unavailableReason: 'source-unreachable',
    })
  })

  it('an unreachable notification centre yields available:false', async () => {
    world.failMutes = true
    expect(await switchOf('notifications')).toMatchObject({
      available: false,
      unavailableReason: 'source-unreachable',
    })
  })

  it('reads the current state of each authority', async () => {
    // The camera stays ENABLED here: a disabled camera is not dialled for
    // its planes (see the next test), so its microphone could not be read.
    world.boundWrappers.delete('detection-pipeline')
    world.recording = { enabled: false, bands: BANDS }
    world.mutedDeviceIds = [101]
    world.cameraAudioEnabled = false
    world.brokerAudioMuted = true
    const group = await get()
    const state = Object.fromEntries(group.switches.map((s) => [s.id, s.enabled]))
    expect(state).toEqual({
      'stream-broker': true,
      'object-detection': false,
      'privacy-mask': false,
      'device-audio': false,
      'broker-audio': false,
      'audio-analysis': true,
      'event-saving': true,
      recording: false,
      notifications: false,
    })
  })

  it('a DISABLED camera is not dialled — its planes say device-disabled, not unreachable', async () => {
    world.deviceDisabled = true
    calls.length = 0
    const group = await get()
    expect(calls.filter((c) => c.method.startsWith('privacyMask.'))).toHaveLength(0)
    const byId = Object.fromEntries(group.switches.map((s) => [s.id, s]))
    expect(byId['stream-broker']).toMatchObject({ available: true, enabled: false })
    expect(byId['device-audio']).toMatchObject({
      available: false,
      unavailableReason: 'device-disabled',
    })
    expect(byId['privacy-mask']).toMatchObject({
      available: false,
      unavailableReason: 'device-disabled',
    })
  })

  // ── the privacy MASK: same cap, same probe, inverted polarity ───────

  it('answers BOTH camera switches from ONE getOptions + getStatus pair', async () => {
    // The cost argument for putting them on one cap. `CameraStatus` pays this
    // fan-out once per camera; a second pair would double it at fleet scale.
    calls.length = 0
    await get()
    expect(calls.filter((c) => c.method === 'privacyMask.getOptions')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'privacyMask.getStatus')).toHaveLength(1)
  })

  it('OFFERS the mask switch with a warning when the camera carries no zones', async () => {
    // Every camera in the live deployment reported exactly this on 2026-08-07
    // — which is precisely why greying it out was wrong: the entry point to
    // the feature was dark on the whole fleet.
    world.cameraMaskRegions = 0
    expect(await switchOf('privacy-mask')).toMatchObject({
      available: true,
      warning: 'no-privacy-zones',
    })
  })

  it('offers NO mask switch on a model that reports it cannot store zones', async () => {
    world.cameraMaskMaxRegions = 0
    expect(await switchOf('privacy-mask')).toMatchObject({
      available: false,
      unavailableReason: 'no-provider',
    })
  })

  it('writes patch.enabled and leaves the operator’s zones byte-identical', async () => {
    // Same rule as `recording`'s `bands`: clearing the drawing to express
    // "off" destroys it, and turning the mask back on would obscure nothing.
    const group = await service.setCameraSwitch(101, 'privacy-mask', true)
    expect(calls.filter((c) => c.method === 'privacyMask.setMask').at(-1)?.input).toEqual({
      deviceId: 101,
      patch: { enabled: true },
    })
    expect(world.cameraMaskRegions).toBe(2)
    expect(world.cameraMaskEnabled).toBe(true)
    expect(group.switches.find((s) => s.id === 'privacy-mask')?.enabled).toBe(true)
  })

  it('the mask write touches no other authority', async () => {
    calls.length = 0
    await service.setCameraSwitch(101, 'privacy-mask', true)
    const writes = calls.filter((c) => c.method.includes('set')).map((c) => c.method)
    expect(writes).toEqual(['privacyMask.setMask'])
  })

  it('ACCEPTS a mask write on a camera with no zones, and keeps zero zones', async () => {
    // The write is real: `patch.enabled` is a camera setting that persists on
    // its own, independent of whether a region exists to blank. Refusing it
    // made the toggle the viewer draws fail with an error the operator could
    // do nothing about. What must NOT happen is a region appearing from
    // nowhere — the write touches the enable flag and only that.
    world.cameraMaskRegions = 0
    calls.length = 0
    await service.setCameraSwitch(101, 'privacy-mask', true)
    expect(calls.filter((c) => c.method.includes('set')).map((c) => c.method)).toEqual([
      'privacyMask.setMask',
    ])
    expect(world.cameraMaskEnabled).toBe(true)
    expect(world.cameraMaskRegions).toBe(0)
  })

  it('still REFUSES a mask write when the zone count could not be READ', async () => {
    // The pair that must stay apart. Unknown is not zero (D315): writing here
    // would flip a flag on a camera whose current state nobody could see.
    world.failPrivacyStatus = true
    await expect(service.setCameraSwitch(101, 'privacy-mask', true)).rejects.toThrow(/privacy-mask/)
    expect(calls.some((c) => c.method === 'privacyMask.setMask')).toBe(false)
  })

  // ── the microphone: a device-NATIVE authority ───────────────────────

  it('offers the microphone switch even though privacy-mask carries NO wrapper', async () => {
    // The regression this pins: `listBindableCapsForDeviceType` reports
    // `privacy-mask` with `wrappers: []`, which the wrapper filter drops. If
    // availability were derived from that row the switch would never appear
    // on any camera.
    expect(await switchOf('device-audio')).toMatchObject({
      available: true,
      enabled: true,
      authority: { kind: 'camera-audio', capName: 'privacy-mask' },
    })
  })

  it('offers NO microphone switch when the camera has no privacy-mask provider', async () => {
    world.nativeCaps.delete('privacy-mask')
    expect(await switchOf('device-audio')).toMatchObject({
      available: false,
      unavailableReason: 'no-provider',
    })
  })

  it('asks the camera NOTHING when it has no privacy-mask provider', async () => {
    // The cheap question first: two guaranteed-failing round trips per camera,
    // paid once per camera by `CameraStatus`, is a fleet-scale cost for an
    // answer the bindings already gave.
    world.nativeCaps.delete('privacy-mask')
    await get()
    expect(calls.some((c) => c.method.startsWith('privacyMask.'))).toBe(false)
  })

  it('offers NO microphone switch when the camera probe says it cannot be muted', async () => {
    world.supportsAudioMute = false
    expect(await switchOf('device-audio')).toMatchObject({
      available: false,
      unavailableReason: 'no-provider',
    })
  })

  it('an unreadable camera yields available:false, never a microphone defaulted to on', async () => {
    world.failPrivacyOptions = true
    expect(await switchOf('device-audio')).toMatchObject({
      available: false,
      unavailableReason: 'source-unreachable',
    })
  })

  it('a camera that supports muting but will not report its state is UNKNOWN, not on', async () => {
    world.failPrivacyStatus = true
    expect(await switchOf('device-audio')).toMatchObject({
      available: false,
      unavailableReason: 'source-unreachable',
    })
  })

  // ── write routing ───────────────────────────────────────────────────

  it('the camera switch routes to deviceManager.setDisabled', async () => {
    await service.setCameraSwitch(101, 'stream-broker', false)
    expect(calls.filter((c) => c.method === 'setDisabled')).toEqual([
      { method: 'setDisabled', input: { deviceId: 101, disabled: true } },
    ])
    expect(world.deviceDisabled).toBe(true)
  })

  it('object detection routes to the detection-pipeline wrapper binding', async () => {
    await service.setCameraSwitch(101, 'object-detection', false)
    expect(calls.filter((c) => c.method === 'setWrapperActive').at(-1)?.input).toEqual({
      deviceId: 101,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })
  })

  it('audio routes to the audio-analysis wrapper binding', async () => {
    await service.setCameraSwitch(101, 'audio-analysis', false)
    expect(calls.filter((c) => c.method === 'setWrapperActive').at(-1)?.input).toEqual({
      deviceId: 101,
      capName: 'audio-analysis',
      wrapperAddonId: 'audio-analyzer',
      active: false,
    })
  })

  it('turning a wrapper back ON picks the registered wrapper for the cap', async () => {
    world.boundWrappers.delete('audio-analysis')
    await service.setCameraSwitch(101, 'audio-analysis', true)
    expect(calls.filter((c) => c.method === 'setWrapperActive').at(-1)?.input).toEqual({
      deviceId: 101,
      capName: 'audio-analysis',
      wrapperAddonId: 'audio-analyzer',
      active: true,
    })
  })

  it('the microphone routes to the CAMERA, and stores nothing here', async () => {
    const group = await service.setCameraSwitch(101, 'device-audio', false)
    expect(calls.filter((c) => c.method === 'privacyMask.setAudioEnabled').at(-1)?.input).toEqual({
      deviceId: 101,
      enabled: false,
    })
    expect(world.cameraAudioEnabled).toBe(false)
    // Recomposed from a fresh read-through of the camera, not from the
    // optimistic value the caller passed in.
    expect(group.switches.find((s) => s.id === 'device-audio')?.enabled).toBe(false)
  })

  it('the microphone switch touches NO other authority', async () => {
    await service.setCameraSwitch(101, 'device-audio', false)
    for (const method of ['setDisabled', 'setWrapperActive', 'setDeviceConfig', 'setDeviceMuted']) {
      expect(calls.some((c) => c.method === method)).toBe(false)
    }
  })

  it('REFUSES to mute a camera whose probe says it has no microphone control', async () => {
    world.supportsAudioMute = false
    await expect(service.setCameraSwitch(101, 'device-audio', false)).rejects.toThrow(
      /device-audio/,
    )
    expect(calls.some((c) => c.method === 'privacyMask.setAudioEnabled')).toBe(false)
  })

  // ── the BROKER's audio plane (D83) ──────────────────────────────────

  it("the broker mute routes to the stream-broker's own store, node-pinned", async () => {
    const group = await service.setCameraSwitch(101, 'broker-audio', false)
    const write = calls.filter((c) => c.method === 'streamBroker.setDeviceAudioMute').at(-1)
    // Polarity inverts on the way in: the switch is "audio is distributed",
    // the fact stored is "muted".
    expect(write?.input).toEqual({ deviceId: 101, muted: true })
    expect(world.brokerAudioMuted).toBe(true)
    // …and comes back out inverted the same way, read fresh from the broker.
    expect(group.switches.find((s) => s.id === 'broker-audio')?.enabled).toBe(false)
  })

  it('the broker mute touches NO other authority — least of all the camera', async () => {
    await service.setCameraSwitch(101, 'broker-audio', false)
    for (const method of [
      'setDisabled',
      'setWrapperActive',
      'setDeviceConfig',
      'setDeviceMuted',
      // The whole point of the row: the camera keeps capturing.
      'privacyMask.setAudioEnabled',
      'privacyMask.setMask',
    ]) {
      expect(calls.some((c) => c.method === method)).toBe(false)
    }
  })

  it('the camera microphone and the broker mute are INDEPENDENT stores', async () => {
    await service.setCameraSwitch(101, 'broker-audio', false)
    expect(world.brokerAudioMuted).toBe(true)
    expect(world.cameraAudioEnabled).toBe(true)

    await service.setCameraSwitch(101, 'device-audio', false)
    expect(world.cameraAudioEnabled).toBe(false)
    expect(world.brokerAudioMuted).toBe(true)

    // Restoring one must not restore the other — a row that silently fixed
    // its sibling would be the two-knobs-that-disagree failure D62 forbids.
    await service.setCameraSwitch(101, 'broker-audio', true)
    expect(world.brokerAudioMuted).toBe(false)
    expect(world.cameraAudioEnabled).toBe(false)
  })

  it('REFUSES to write the broker mute when the broker node did not answer', async () => {
    world.failBrokerAudio = true
    await expect(service.setCameraSwitch(101, 'broker-audio', false)).rejects.toThrow(
      /broker-audio/,
    )
    expect(calls.some((c) => c.method === 'streamBroker.setDeviceAudioMute')).toBe(false)
  })

  it('an unreachable broker node removes only ITS row', async () => {
    world.failBrokerAudio = true
    const group = await get()
    expect(group.switches.find((s) => s.id === 'broker-audio')).toMatchObject({
      available: false,
      unavailableReason: 'source-unreachable',
    })
    for (const id of ['stream-broker', 'recording', 'notifications', 'device-audio']) {
      expect(group.switches.find((s) => s.id === id)?.available).toBe(true)
    }
  })

  it('notifications route to the permanent per-camera mute', async () => {
    await service.setCameraSwitch(101, 'notifications', false)
    expect(calls.filter((c) => c.method === 'setDeviceMuted').at(-1)?.input).toEqual({
      deviceId: 101,
      muted: true,
    })
    expect(world.mutedDeviceIds).toEqual([101])
  })

  // ── recording: enabled, NEVER the bands ─────────────────────────────

  it('recording flips `enabled` and leaves `bands` byte-identical', async () => {
    await service.setCameraSwitch(101, 'recording', false)
    expect(world.recording).toEqual({ enabled: false, bands: BANDS })
    // The authored schedule survives, so turning it back on records exactly
    // what the operator asked for — clearing bands would silently record
    // nothing forever after.
    expect(world.recording?.bands).toEqual(BANDS)
  })

  it('recording preserves every other authored field', async () => {
    world.recording = {
      enabled: true,
      bands: BANDS,
      profiles: ['high'],
      segmentSeconds: 300,
      retention: { maxAgeDays: 14 },
    }
    await service.setCameraSwitch(101, 'recording', false)
    expect(world.recording).toEqual({
      enabled: false,
      bands: BANDS,
      profiles: ['high'],
      segmentSeconds: 300,
      retention: { maxAgeDays: 14 },
    })
  })

  it('recording never authors `mode` — it is derived by the recorder on save', async () => {
    await service.setCameraSwitch(101, 'recording', false)
    expect(world.recording && 'mode' in world.recording).toBe(false)
  })

  it('turning recording back on restores the operator schedule untouched', async () => {
    await service.setCameraSwitch(101, 'recording', false)
    await service.setCameraSwitch(101, 'recording', true)
    expect(world.recording).toEqual({ enabled: true, bands: BANDS })
  })

  // ── refusal ─────────────────────────────────────────────────────────

  it('REFUSES a switch this camera does not offer rather than persisting it', async () => {
    world.bindable = world.bindable.filter((b) => b.capName !== 'audio-analysis')
    await expect(service.setCameraSwitch(101, 'audio-analysis', false)).rejects.toThrow(
      /audio-analysis/,
    )
    expect(calls.some((c) => c.method === 'setWrapperActive')).toBe(false)
  })

  it('REFUSES to write when the authority could not be read', async () => {
    world.failRecording = true
    await expect(service.setCameraSwitch(101, 'recording', false)).rejects.toThrow(/recording/)
    expect(calls.some((c) => c.method === 'setDeviceConfig')).toBe(false)
  })

  // ── the return value is the fresh group ─────────────────────────────

  it('returns the RECOMPOSED group, so a client never renders its own guess', async () => {
    const group = await service.setCameraSwitch(101, 'object-detection', false)
    const detection = group.switches.find((s) => s.id === 'object-detection')
    expect(detection?.enabled).toBe(false)
  })

  // ── disabled vs broken ──────────────────────────────────────────────

  it('the badge names what an operator turned off, and nothing else', async () => {
    world.boundWrappers.delete('detection-pipeline')
    world.recording = { enabled: false, bands: [] }
    expect([...(await switchedOffFor(101))].toSorted()).toEqual(['object-detection', 'recording'])
  })

  it('the badge is EMPTY for a healthy camera — quiet then means broken', async () => {
    expect(await switchedOffFor(101)).toEqual([])
  })

  it('the badge never names an authority it could not READ as switched off', async () => {
    world.failMutes = true
    expect(await switchedOffFor(101)).toEqual([])
  })

  // ── slow is not the same as broken ──────────────────────────────────
  //
  // Measured on the live hub, 2026-08-08: `privacyMask.getStatus` answered in
  // 3.1–3.6s on device 105 on EVERY call (the cap probes the camera itself)
  // while all seven other sources answered in under 15ms. `gather()` awaited
  // it unbounded, so `getCameraSwitches(105)` took 5.5–6.0s, and
  // `getCameraStatus(105)` — which bounds the whole switch read at 3s and
  // degrades to `[]` — reported `switchedOff: []` three times out of three
  // while the operator had BOTH `stream-broker` and `recording` turned off.
  //
  // That is the exact failure the group exists to remove: the camera read as
  // BROKEN because one unrelated source was slow. The bound belongs per
  // SOURCE, inside the gather, so one slow camera probe costs its own two
  // switches and nothing else.

  const SLOW = 60_000

  it('bounds a slow source instead of waiting for it', async () => {
    vi.useFakeTimers()
    try {
      world.slowMs.set('privacyMask.getStatus', SLOW)
      const pending = service.getCameraSwitches(101)
      await vi.advanceTimersByTimeAsync(10_000)
      const group = await pending
      expect(group.switches.find((s) => s.id === 'device-audio')).toMatchObject({
        available: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('one slow source does not erase the OTHER switches', async () => {
    vi.useFakeTimers()
    try {
      // Exactly device 105's live shape: the camera probe crawls, and the
      // operator has turned two unrelated functions off.
      world.slowMs.set('privacyMask.getStatus', SLOW)
      world.boundWrappers.delete('detection-pipeline')
      world.recording = { enabled: false, bands: [] }
      const pending = switchedOffFor(101)
      await vi.advanceTimersByTimeAsync(10_000)
      expect([...(await pending)].toSorted()).toEqual(['object-detection', 'recording'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the whole gather completes inside the status stage budget', async () => {
    vi.useFakeTimers()
    try {
      // Every remote source hangs — the worst case the two-stage gather can
      // present. It must still land under the 3s `STAGE_TIMEOUT_MS` that
      // `CameraStatusService` gives this read, or the status surface degrades
      // to "nothing switched off" and a disabled camera looks broken.
      for (const method of [
        'getDevice',
        'getBindings',
        'getDeviceConfig',
        'listDeviceMutes',
        'streamBroker.getDeviceAudioMute',
        'listBindableCapsForDeviceType',
        'privacyMask.getOptions',
        'privacyMask.getStatus',
      ])
        world.slowMs.set(method, SLOW)
      let settled = false
      const pending = service.getCameraSwitches(101).then((g) => {
        settled = true
        return g
      })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(settled).toBe(true)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('LOGS the source it gave up on, tagged with the deviceId', async () => {
    vi.useFakeTimers()
    try {
      world.slowMs.set('privacyMask.getStatus', SLOW)
      const pending = service.getCameraSwitches(101)
      await vi.advanceTimersByTimeAsync(10_000)
      await pending
    } finally {
      vi.useRealTimers()
    }
    // A branch that drops work silently reads as "it never happened". The tag
    // is the numeric deviceId because every question asked of this is
    // per-camera ("why is 105 slower than 101?").
    const timedOut = warnings.filter((w) => w.meta?.['source'] === 'privacyMask.getStatus')
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]?.tags).toEqual({ deviceId: 101 })
  })
})
