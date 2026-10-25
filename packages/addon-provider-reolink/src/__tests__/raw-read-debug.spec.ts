import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { reolinkDebugActions } from '../debug-actions.js'
import {
  performRawRead,
  RAW_READ_CATALOG,
  RAW_READ_SLICE_NAMES,
  RawReadInputSchema,
  RawReadResultSchema,
  RawReadSliceSchema,
  type RawReadApi,
  type RawReadDeps,
} from '../raw-read.js'

/**
 * Raw-read debug surface (D346): "what does the camera actually report,
 * versus what CamStack believes?"
 *
 * The operator-facing failure this exists for: the settings form said the
 * channel-name overlay was ON while the camera had it OFF, and the camera's
 * own (unprojected) answer was unrecoverable without Baichuan tracing.
 *
 * Properties pinned here:
 *   - the surface is READ-ONLY by construction — the slice enum maps onto
 *     an allow-list of lib `get*` calls, nothing else is reachable;
 *   - it is secret-free by ALLOW-LIST: the credential-echoing reads
 *     (email/SMTP, users/sessions) are not in the catalog, and the device
 *     config (which carries `password`) is never consulted;
 *   - a sleeping battery camera REFUSES before any login (logging in IS
 *     the wake) and still reports the believed state;
 *   - the payload is returned unprojected — fields the snapshot
 *     projection discards must survive;
 *   - the action is admin-only, or the whole surface leaks to viewers.
 */

const here = dirname(fileURLToPath(import.meta.url))
const addonSource = readFileSync(resolve(here, '../addon.ts'), 'utf8')
const indexSource = readFileSync(resolve(here, '../index.ts'), 'utf8')
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

const NOW = 1_756_000_000_000

function makeLogger(lines: Array<{ level: string; message: string; extras?: LogExtras }>) {
  const log =
    (level: string) =>
    (message: string, extras?: LogExtras): void => {
      lines.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/**
 * A fake api that records every property ACCESS and answers every method
 * with a canned payload. Accessing anything that does not start with `get`
 * throws — which is exactly how the "read-only by construction" claim is
 * proven against the real catalog rather than against a comment.
 */
function makeRecordingApi(payload: unknown): { api: RawReadApi; accessed: string[] } {
  const accessed: string[] = []
  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop)
        // Promise-resolution probes on the proxy itself, not lib calls.
        if (name === 'then') return undefined
        accessed.push(name)
        if (!name.startsWith('get')) {
          throw new Error(`raw-read touched non-read api member "${name}"`)
        }
        return () => Promise.resolve(payload)
      },
    },
  ) as RawReadApi
  return { api, accessed }
}

function makeDeps(overrides: Partial<RawReadDeps>): RawReadDeps {
  return {
    deviceId: 108,
    channel: 0,
    sleeping: false,
    hubChild: false,
    // Device 108 is a PTZ camera; the focus read is gated on this and every
    // other slice ignores it.
    hasPtz: true,
    getApi: () => Promise.resolve(makeRecordingApi({}).api),
    cache: undefined,
    batteryState: undefined,
    logger: makeLogger([]),
    now: NOW,
    ...overrides,
  }
}

/**
 * Canned lib answers. `battery` is the one slice whose payload has
 * STRUCTURE the invoke walks, and it has TWO shapes because it has two
 * reads: the hub's channel-keyed CGI map, and the camera's own
 * `getBatteryInfo`. Measured live 2026-09-05 — the hub answers
 * `adapterStatus:1` for a plugged Argus 3E; the standalone cams
 * (640 Baby monitor, 4263 Campanello) run on battery alone.
 */
const HUB_BATTERY_ANSWER = {
  batteryInfoData: {
    0: {
      batteryLevel: 80,
      sleeping: false,
      entries: [{ batteryPercent: 80, adapterStatus: 1, chargeStatus: 2 }, { channel: 0 }],
    },
  },
}

const STANDALONE_BATTERY_ANSWER = {
  batteryPercent: 83,
  chargeStatus: 'none',
  adapterStatus: 'none',
  lowPower: 0,
  voltage: 3900,
  batteryVersion: 2,
  sleeping: false,
  channel: 0,
}

/**
 * The sweep runs every slice with `hubChild: false`, so `battery` takes the
 * standalone read there. An empty array satisfies every cache-backed read
 * (including the `ai` fan-out).
 */
function cannedAnswerFor(slice: string): unknown {
  return slice === 'battery' ? STANDALONE_BATTERY_ANSWER : []
}

describe('the catalog is an allow-list of reads — nothing else is reachable', () => {
  it('every slice resolves through get* lib calls only', async () => {
    for (const slice of RAW_READ_SLICE_NAMES) {
      const { api, accessed } = makeRecordingApi(cannedAnswerFor(slice))
      const result = await performRawRead(slice, makeDeps({ getApi: () => Promise.resolve(api) }))
      expect(result.ok, `slice ${slice} should succeed against the recording api`).toBe(true)
      expect(accessed.length, `slice ${slice} must issue at least one read`).toBeGreaterThan(0)
      for (const name of accessed) {
        expect(name.startsWith('get'), `slice ${slice} accessed "${name}"`).toBe(true)
      }
    }
  })

  it('the credential-echoing reads are NOT in the catalog (allow-list, not blocklist)', () => {
    // `getEmail` echoes the camera's SMTP credentials; user/session lists
    // carry account material. None of them may ever become a slice.
    const sliceNames = new Set<string>(RAW_READ_SLICE_NAMES)
    expect(sliceNames.has('email')).toBe(false)
    expect(sliceNames.has('emailConfig')).toBe(false)
    expect(sliceNames.has('sessions')).toBe(false)
    expect(sliceNames.has('users')).toBe(false)
    for (const entry of Object.values(RAW_READ_CATALOG)) {
      expect(entry.command).not.toMatch(/email|user|login|password|token/i)
      if (entry.believed.kind === 'deviceCache') {
        expect(entry.believed.snapshotKey).not.toBe('emailConfigSnapshot')
      }
    }
  })

  it('an out-of-catalog slice is rejected by the input schema', () => {
    expect(RawReadSliceSchema.safeParse('email').success).toBe(false)
    expect(RawReadSliceSchema.safeParse('setOsd').success).toBe(false)
    expect(RawReadInputSchema.safeParse({ deviceId: 108, slice: 'getEmail' }).success).toBe(false)
    expect(RawReadInputSchema.safeParse({ deviceId: 108, slice: 'osd' }).success).toBe(true)
  })

  it('secrets living NEXT to the requested slice never reach the output', async () => {
    // The believed state is built ONLY from the slice's snapshot key; a
    // cache that carries auth material elsewhere (the loose blob could —
    // and `emailConfigSnapshot` does carry the SMTP account) must not leak.
    const { api } = makeRecordingApi({ osdChannel: { enable: 0 } })
    const result = await performRawRead(
      'osd',
      makeDeps({
        getApi: () => Promise.resolve(api),
        cache: {
          osdSnapshot: { channelEnabled: true, fetchedAt: NOW - 1000 },
          emailConfigSnapshot: { userName: 'cam@example.com', lastReadAt: NOW - 5000 },
          password: 'hunter2', // loose-blob worst case: config leaked into cache
        },
      }),
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('cam@example.com')
  })
})

describe('sleeping battery camera — refuse BEFORE login, loudly, with the believed state', () => {
  it('never calls getApi and returns a sleeping refusal', async () => {
    let apiRequested = false
    const lines: Array<{ level: string; message: string; extras?: LogExtras }> = []
    const result = await performRawRead(
      'osd',
      makeDeps({
        sleeping: true,
        logger: makeLogger(lines),
        getApi: () => {
          apiRequested = true
          return Promise.resolve(makeRecordingApi({}).api)
        },
        cache: { osdSnapshot: { channelEnabled: false, fetchedAt: NOW - 60_000 } },
      }),
    )
    expect(apiRequested, 'a sleeping cam must never be logged into — login IS the wake').toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('sleeping')
    // The refusal still answers "what does CamStack believe".
    expect(result.believed.snapshot).toMatchObject({ channelEnabled: false })
    expect(result.believed.age).toEqual({
      state: 'known',
      fetchedAt: NOW - 60_000,
      ageMs: 60_000,
    })
    // Loud: one info line, tagged with the deviceId.
    const refusal = lines.find((l) => l.message.includes('raw read refused'))
    expect(refusal?.level).toBe('info')
    expect(refusal?.extras?.tags).toMatchObject({ deviceId: 108 })
  })
})

describe('the payload is the library response, unprojected', () => {
  it('fields the snapshot projection discards survive to the caller', async () => {
    // The OSD slice reads `getOsdDatetime` (cmd_id 44) — the RAW form of
    // what the driver reads through `getOsd`, so every field the camera sent
    // reaches the operator before the snapshot projection drops any of it.
    const rawOsd = {
      osdDatetime: { channelId: 3, enable: true, topLeftX: 65_536, topLeftY: 1 },
      osdChannelName: {
        channelId: 3,
        name: 'Magicam',
        enable: true,
        topLeftX: 65_536,
        topLeftY: 65_536,
        enWatermark: true,
        enBgcolor: false,
      },
    }
    const { api } = makeRecordingApi(rawOsd)
    const result = await performRawRead(
      'osd',
      makeDeps({
        getApi: () => Promise.resolve(api),
        cache: { osdSnapshot: { channelEnabled: true, fetchedAt: NOW - 1000 } },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Unprojected on both sides: every field the camera sent survives.
    expect(result.camera).toEqual(rawOsd)
    expect(result.command).toContain('getOsdDatetime')
    // Side-by-side: the believed (projected) snapshot rides along, so the
    // operator sees BOTH sides of the disagreement in one answer.
    expect(result.believed.source).toEqual({ kind: 'deviceCache', snapshotKey: 'osdSnapshot' })
    expect(result.believed.snapshot).toMatchObject({ channelEnabled: true })
    expect(RawReadResultSchema.safeParse(result).success).toBe(true)
  })

  it('a legacy snapshot with no stamp reports age unknown — never fresh', async () => {
    const { api } = makeRecordingApi({})
    const result = await performRawRead(
      'enc',
      makeDeps({
        getApi: () => Promise.resolve(api),
        cache: { encSnapshot: { audio: 1 } },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.believed.age).toEqual({ state: 'unknown' })
  })

  it('a never-read slice reports never — not-yet-known must not look like known-empty', async () => {
    const { api } = makeRecordingApi({})
    const result = await performRawRead('pir', makeDeps({ getApi: () => Promise.resolve(api) }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.believed.age).toEqual({ state: 'never' })
    expect(result.believed.snapshot).toBeNull()
  })
})

describe('failures are visible and still carry the believed state', () => {
  it('login failure → login-failed refusal, logged at info with deviceId', async () => {
    const lines: Array<{ level: string; message: string; extras?: LogExtras }> = []
    const result = await performRawRead(
      'ntp',
      makeDeps({
        logger: makeLogger(lines),
        getApi: () => Promise.reject(new Error('camera unreachable')),
        cache: { ntpSnapshot: { enabled: true }, snapshotFetchedAt: { ntpSnapshot: NOW - 5000 } },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('login-failed')
    expect(result.message).toContain('camera unreachable')
    expect(result.believed.age).toEqual({ state: 'known', fetchedAt: NOW - 5000, ageMs: 5000 })
    const line = lines.find((l) => l.message.includes('login failed'))
    expect(line?.level).toBe('info')
    expect(line?.extras?.tags).toMatchObject({ deviceId: 108 })
  })

  it('a read that throws → read-failed refusal with the error message', async () => {
    const api = new Proxy(
      {},
      {
        get(_t, prop) {
          if (String(prop) === 'then') return undefined
          return () => Promise.reject(new Error('cmd timeout'))
        },
      },
    ) as RawReadApi
    const result = await performRawRead('led', makeDeps({ getApi: () => Promise.resolve(api) }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('read-failed')
    expect(result.message).toContain('cmd timeout')
  })
})

describe('the action surface is admin-only and correctly wired', () => {
  it('debugRawRead declares auth admin — the raw payload surface must never be viewer-reachable', () => {
    expect(reolinkDebugActions.debugRawRead.auth).toBe('admin')
    expect(reolinkDebugActions.debugRawRead.kind).toBe('query')
    expect(reolinkDebugActions.debugRawRead.scope).toEqual({ kind: 'system' })
  })

  it('the addon registers the catalog + handler through its init result (structural)', () => {
    expect(addonSource).toContain('customActions: reolinkDebugActions')
    expect(addonSource).toContain('debugRawRead: (input) => this.debugRawRead(input)')
  })

  it('the bundle exports the static catalog the hub-side registry resolves (structural)', () => {
    expect(indexSource).toContain('export { reolinkDebugActions as customActions }')
  })

  it('the camera evaluates the sleep gate and never persists from a raw read (structural)', () => {
    const method = cameraSource.slice(cameraSource.indexOf('async debugRawRead('))
    const body = method.slice(0, method.indexOf('\n  }'))
    expect(body).toContain('sleeping: this.isBattery && this.sleeping')
    expect(body).not.toContain('setAll')
  })
})

/**
 * The `battery` slice (added to answer: "is `adapterStatus` a real signal
 * or a constant?"). Two things about it do not fit the other fifteen:
 *
 *   1. the read is a HUB-level CGI over ALL channels
 *      (`getAllChannelsBatteryInfo`), so the slice projects the requested
 *      channel itself rather than introducing a second slice shape;
 *   2. there is no `deviceCache` field for battery at all — what CamStack
 *      believes lives in the `battery` capability's runtime state
 *      (percentage / charging / sleeping). The catalog therefore names a
 *      believed SOURCE, and no fake cache key was invented to make a
 *      `snapshotKey` type fit.
 */
describe('battery — one slice, two firmware reads, chosen by how the camera is attached', () => {
  it('is in the catalog and names the cap runtime state as its believed source', () => {
    const sliceNames: readonly string[] = RAW_READ_SLICE_NAMES
    expect(sliceNames).toContain('battery')
    expect(RAW_READ_CATALOG.battery.believed).toEqual({
      kind: 'capRuntimeState',
      capName: 'battery',
    })
  })

  it('a HUB CHILD reads the hub CGI; a STANDALONE reads its own getBatteryInfo', async () => {
    const hub = makeRecordingApi(HUB_BATTERY_ANSWER)
    const hubResult = await performRawRead(
      'battery',
      makeDeps({ hubChild: true, getApi: () => Promise.resolve(hub.api) }),
    )
    expect(hub.accessed).toContain('getAllChannelsBatteryInfo')
    expect(hub.accessed).not.toContain('getBatteryInfo')
    expect(hubResult.ok).toBe(true)
    if (!hubResult.ok) throw new Error('unreachable')
    expect(hubResult.camera).toMatchObject({ readVia: 'parentHub' })

    const solo = makeRecordingApi(STANDALONE_BATTERY_ANSWER)
    const soloResult = await performRawRead(
      'battery',
      makeDeps({ deviceId: 106, hubChild: false, getApi: () => Promise.resolve(solo.api) }),
    )
    expect(solo.accessed).toContain('getBatteryInfo')
    expect(solo.accessed).not.toContain('getAllChannelsBatteryInfo')
    expect(soloResult.ok, 'a standalone battery camera must be READ, not refused').toBe(true)
    if (!soloResult.ok) throw new Error('unreachable')
    expect(soloResult.camera).toMatchObject({ readVia: 'camera' })
    expect(RawReadResultSchema.safeParse(soloResult).success).toBe(true)
  })

  it("the standalone answer is the firmware's, verbatim — adapterStatus included", async () => {
    const { api } = makeRecordingApi(STANDALONE_BATTERY_ANSWER)
    const result = await performRawRead(
      'battery',
      makeDeps({ deviceId: 4263, channel: 0, getApi: () => Promise.resolve(api) }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.camera).toMatchObject({
      readVia: 'camera',
      command: 'getBatteryInfo',
      channel: 0,
      batteryInfo: STANDALONE_BATTERY_ANSWER,
    })
  })

  it('a field the firmware did not send is ABSENT, never defaulted into looking read', async () => {
    // The two paths do not carry the same vocabulary (`voltage`/`lowPower`
    // on the camera read, `channelsReported`/channel-status on the hub
    // read). Normalising them into one shape would invent values — the
    // whole point of the slice is seeing what the device actually said.
    const { api } = makeRecordingApi({ batteryPercent: 79, chargeStatus: 'none' })
    const result = await performRawRead(
      'battery',
      makeDeps({ deviceId: 4263, getApi: () => Promise.resolve(api) }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const camera: unknown = result.camera
    if (typeof camera !== 'object' || camera === null) throw new Error('unreachable')
    const batteryInfo: unknown = Reflect.get(camera, 'batteryInfo')
    if (typeof batteryInfo !== 'object' || batteryInfo === null) throw new Error('unreachable')
    expect(Object.keys(batteryInfo)).toEqual(['batteryPercent', 'chargeStatus'])
    expect('adapterStatus' in batteryInfo).toBe(false)
  })

  it('projects the requested channel out of the all-channels map, adapterStatus intact', async () => {
    const { api } = makeRecordingApi({
      batteryInfoData: {
        0: { batteryLevel: 12, sleeping: false, entries: [{ batteryPercent: 12 }, { channel: 0 }] },
        3: {
          batteryLevel: 97,
          sleeping: true,
          entries: [
            { batteryPercent: 97, adapterStatus: 1, chargeStatus: 2, current: -120 },
            { channel: 3, name: 'MagiCam', online: 1, sleep: 1 },
          ],
        },
      },
    })
    const result = await performRawRead(
      'battery',
      makeDeps({ deviceId: 3825, channel: 3, hubChild: true, getApi: () => Promise.resolve(api) }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // The projection is the requested channel only — the neighbour's
    // battery must not ride along and be misread as this camera's.
    const payload = JSON.stringify(result.camera)
    expect(payload).toContain('"adapterStatus":1')
    expect(payload).not.toContain('"batteryLevel":12')
    expect(result.camera).toMatchObject({ channel: 3, channelsReported: [0, 3] })
    expect(RawReadResultSchema.safeParse(result).success).toBe(true)
  })

  it('the channel-status UID never reaches the payload', async () => {
    // `entries[1]` is the hub's channel-status row — it carries the
    // camera's Reolink P2P `uid`, a routable cloud identifier that a
    // charge-state read has no reason to hand out.
    const { api } = makeRecordingApi({
      batteryInfoData: {
        1: {
          batteryLevel: 55,
          sleeping: false,
          entries: [{ batteryPercent: 55 }, { channel: 1, uid: '95270000ABCDEF01', name: 'Argus' }],
        },
      },
    })
    const result = await performRawRead(
      'battery',
      makeDeps({ channel: 1, hubChild: true, getApi: () => Promise.resolve(api) }),
    )
    expect(JSON.stringify(result)).not.toContain('95270000ABCDEF01')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // The camera still gets to say the row existed — redaction is stated,
    // not silently indistinguishable from a firmware that sent no row.
    expect(JSON.stringify(result.camera)).toContain('uidRedacted')
  })

  it('a channel the hub did not report REFUSES and says why — never an empty that reads as "no battery"', async () => {
    const lines: Array<{ level: string; message: string; extras?: LogExtras }> = []
    const { api } = makeRecordingApi({
      batteryInfoData: { 0: { batteryLevel: 80, sleeping: false, entries: [{}, {}] } },
    })
    const result = await performRawRead(
      'battery',
      makeDeps({
        deviceId: 3825,
        channel: 7,
        hubChild: true,
        logger: makeLogger(lines),
        getApi: () => Promise.resolve(api),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('channel 7')
    expect(result.message).toMatch(/did not report|not report/i)
    // A dropped read is never silent, and the line is per-camera.
    const line = lines.find((l) => l.message.includes('raw read failed'))
    expect(line?.extras?.tags).toMatchObject({ deviceId: 3825 })
  })

  it('the believed state is the battery cap slice, aged from lastUpdated', async () => {
    const { api } = makeRecordingApi(STANDALONE_BATTERY_ANSWER)
    const result = await performRawRead(
      'battery',
      makeDeps({
        getApi: () => Promise.resolve(api),
        batteryState: {
          percentage: 100,
          charging: 'none',
          sleeping: true,
          lastUpdated: NOW - 30_000,
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.believed.source).toEqual({ kind: 'capRuntimeState', capName: 'battery' })
    expect(result.believed.snapshot).toMatchObject({ percentage: 100, charging: 'none' })
    expect(result.believed.age).toEqual({
      state: 'known',
      fetchedAt: NOW - 30_000,
      ageMs: 30_000,
    })
  })

  it('no battery slice at all reports `never` — not a believed 0%', async () => {
    const { api } = makeRecordingApi(STANDALONE_BATTERY_ANSWER)
    const result = await performRawRead(
      'battery',
      makeDeps({ getApi: () => Promise.resolve(api), batteryState: undefined }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.believed.age).toEqual({ state: 'never' })
    expect(result.believed.snapshot).toBeNull()
  })

  it('an unseeded slice (lastUpdated 0) is `never`, not "read at the epoch"', async () => {
    const { api } = makeRecordingApi(STANDALONE_BATTERY_ANSWER)
    const result = await performRawRead(
      'battery',
      makeDeps({
        getApi: () => Promise.resolve(api),
        batteryState: { percentage: null, charging: 'none', sleeping: false, lastUpdated: 0 },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.believed.age).toEqual({ state: 'never' })
  })
})

describe('battery — the sleep gate applies to the CAMERA, not to the hub CGI', () => {
  it('a SLEEPING HUB CHILD is served: the parent hub answers, the camera is never touched', async () => {
    const lines: Array<{ level: string; message: string; extras?: LogExtras }> = []
    const { api } = makeRecordingApi(HUB_BATTERY_ANSWER)
    const result = await performRawRead(
      'battery',
      makeDeps({
        deviceId: 3825,
        sleeping: true,
        hubChild: true,
        logger: makeLogger(lines),
        getApi: () => Promise.resolve(api),
      }),
    )
    expect(
      result.ok,
      'the hub CGI never reaches the sleeping channel — refusing hides the fact',
    ).toBe(true)
    const served = lines.find((l) => l.message.includes('raw read served'))
    expect(served?.extras?.tags).toMatchObject({ deviceId: 3825 })
  })

  it('a SLEEPING STANDALONE camera still refuses — its own login IS the wake', async () => {
    let apiRequested = false
    const result = await performRawRead(
      'battery',
      makeDeps({
        sleeping: true,
        hubChild: false,
        getApi: () => {
          apiRequested = true
          return Promise.resolve(makeRecordingApi(STANDALONE_BATTERY_ANSWER).api)
        },
      }),
    )
    expect(apiRequested).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('sleeping')
  })

  it('the exemption is the battery slice ONLY — every other slice still refuses on a sleeping hub child', async () => {
    for (const slice of RAW_READ_SLICE_NAMES) {
      if (slice === 'battery') continue
      let apiRequested = false
      const result = await performRawRead(
        slice,
        makeDeps({
          sleeping: true,
          hubChild: true,
          getApi: () => {
            apiRequested = true
            return Promise.resolve(makeRecordingApi(cannedAnswerFor(slice)).api)
          },
        }),
      )
      expect(apiRequested, `slice ${slice} must not reach a sleeping camera`).toBe(false)
      expect(result.ok, `slice ${slice} must refuse while asleep`).toBe(false)
    }
  })

  it('the camera hands the raw read its hub-child flag and the battery cap slice (structural)', () => {
    const method = cameraSource.slice(cameraSource.indexOf('async debugRawRead('))
    const body = method.slice(0, method.indexOf('\n  }'))
    expect(body).toContain('hubChild: this.isHubChild()')
    expect(body).toContain("getCapState('battery')")
    expect(body).not.toContain('setAll')
  })
})
