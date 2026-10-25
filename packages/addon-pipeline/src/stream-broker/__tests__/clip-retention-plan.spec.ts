/**
 * The broker applies the retention THIS camera's notification rules ask for —
 * and never confuses "told: nothing" with "not yet told".
 *
 * Before this the ring was flat: every camera paid the full minute the
 * occupancy rules need, and the PROFILE was learned reactively, after the first
 * clip had already been cut from the wrong one. The asks come from the
 * notification centre (`notificationRules.getClipRetentionAsks`) and this
 * manager takes the MAX over the ones that reach a camera.
 *
 * The case that must never regress is the third one: a broker that has not
 * heard from the centre yet keeps the full minute. Dropping the ring on boot,
 * before the rules load, loses the footage for exactly the first events after
 * every restart.
 *
 * Harness: the manager/RTSP/api stubs of `catalog-reconcile-keeps-derived.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AddonApi,
  CamProfile,
  CamStreamDescriptor,
  IScopedLogger,
  NcClipRetentionAsk,
} from '@camstack/types'
import type { StreamBroker } from '../stream-broker/stream-broker.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

const CAM_A = 101
const CAM_B = 102

interface LoggedLine {
  readonly message: string
  readonly deviceId: number | undefined
  readonly seconds: number | undefined
}

function makeLogger(lines: LoggedLine[]): IScopedLogger {
  const record =
    (level: 'info') =>
    (
      message: string,
      opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ) => {
      if (level !== 'info') return
      const deviceId = opts?.tags?.deviceId
      const seconds = opts?.meta?.seconds
      lines.push({
        message,
        deviceId: typeof deviceId === 'number' ? deviceId : undefined,
        seconds: typeof seconds === 'number' ? seconds : undefined,
      })
    }
  const l: IScopedLogger = {
    info: record('info'),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

const CATALOG: readonly CamStreamDescriptor[] = [
  {
    camStreamId: 'native:main',
    kind: 'pull-rtsp',
    url: 'rtsp://x/main',
    resolution: { width: 2560, height: 1440 },
  },
  {
    camStreamId: 'native:sub',
    kind: 'pull-rtsp',
    url: 'rtsp://x/sub',
    resolution: { width: 640, height: 360 },
  },
]

/** The notification centre's answer — or a refusal to answer. */
type PlanAnswer =
  | { readonly kind: 'plan'; readonly rulesLoaded: boolean; readonly asks: NcClipRetentionAsk[] }
  | { readonly kind: 'unreachable' }

function makeApi(answer: () => PlanAnswer): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [
          { id: CAM_A, type: 'camera', isCamera: true, disabled: false },
          { id: CAM_B, type: 'camera', isCamera: true, disabled: false },
        ]),
      },
    },
    streamCatalog: {
      getCatalog: { query: vi.fn(async () => CATALOG) },
    },
    notificationRules: {
      getClipRetentionAsks: {
        query: vi.fn(async () => {
          const a = answer()
          if (a.kind === 'unreachable') throw new Error('notification centre unreachable')
          return { rulesLoaded: a.rulesLoaded, asks: a.asks }
        }),
      },
    },
  } as unknown as AddonApi
}

/** Seconds retained on the given profile slot of a camera. */
function retained(manager: StreamBrokerManager, deviceId: number, profile: CamProfile): number {
  const assignments = (
    manager as unknown as {
      assignments: Map<number, { map: Partial<Record<CamProfile, string>> }>
    }
  ).assignments
  const camStreamId = assignments.get(deviceId)?.map[profile]
  if (camStreamId === undefined) return -1
  const brokers = (manager as unknown as { brokers: Map<string, StreamBroker> }).brokers
  return brokers.get(`${deviceId}/${camStreamId}`)?.getClipRetentionSec() ?? -1
}

const WINDOW_ASK: NcClipRetentionAsk = {
  deviceId: CAM_A,
  seconds: 20,
  reason: 'window',
  ruleId: 'r-gif',
  ruleName: 'Persona su Uscio',
}
const OCCUPANCY_ASK: NcClipRetentionAsk = {
  deviceId: CAM_B,
  seconds: 60,
  reason: 'occupancy',
  ruleId: 'r-occ',
  ruleName: 'Pat è andato via',
}

describe('clip retention × the notification rules’ asks', () => {
  let manager: StreamBrokerManager
  let lines: LoggedLine[]
  let answer: PlanAnswer

  beforeEach(() => {
    lines = []
    answer = { kind: 'plan', rulesLoaded: true, asks: [WINDOW_ASK, OCCUPANCY_ASK] }
    manager = new StreamBrokerManager(makeLogger(lines))
    stubRtsp(manager)
    manager.setApiAccess(makeApi(() => answer))
  })

  afterEach(async () => {
    await manager.destroyAll()
  })

  it('retains what each camera’s own rules ask for — not one flat number', async () => {
    await manager.reconcileAllCatalogs()

    // The cheap profile is the one a clip is cut from, and it is the one armed.
    expect(retained(manager, CAM_A, 'low')).toBe(20)
    expect(retained(manager, CAM_B, 'low')).toBe(60)
    // The expensive rendition is never armed by an ask that did not name it.
    expect(retained(manager, CAM_A, 'high')).toBe(0)
  })

  it('a camera NO rule asks about retains NOTHING', async () => {
    answer = { kind: 'plan', rulesLoaded: true, asks: [OCCUPANCY_ASK] }
    await manager.reconcileAllCatalogs()

    expect(retained(manager, CAM_A, 'low')).toBe(0)
    expect(retained(manager, CAM_B, 'low')).toBe(60)
  })

  it('a camera the centre has NOT spoken about yet keeps the full minute', async () => {
    // Boot: the notification centre is not up, or its rules have not loaded.
    // Absence must not read as zero — these are the first events after a
    // restart, and their footage is exactly what this ring is for.
    answer = { kind: 'unreachable' }
    await manager.reconcileAllCatalogs()
    expect(retained(manager, CAM_A, 'low')).toBe(60)
    expect(retained(manager, CAM_B, 'low')).toBe(60)

    answer = { kind: 'plan', rulesLoaded: false, asks: [] }
    await manager.reconcileAllCatalogs()
    expect(retained(manager, CAM_A, 'low')).toBe(60)
  })

  it('a pull that FAILS after a good one changes nothing (D49)', async () => {
    await manager.reconcileAllCatalogs()
    expect(retained(manager, CAM_A, 'low')).toBe(20)

    answer = { kind: 'unreachable' }
    await manager.reconcileAllCatalogs()

    expect(retained(manager, CAM_A, 'low')).toBe(20)
    expect(retained(manager, CAM_B, 'low')).toBe(60)
  })

  it('re-derives when the rules change — the ring follows a rule that was deleted', async () => {
    await manager.reconcileAllCatalogs()
    expect(retained(manager, CAM_B, 'low')).toBe(60)

    // The operator deletes the occupancy rule; the next tick shrinks the ring.
    answer = { kind: 'plan', rulesLoaded: true, asks: [WINDOW_ASK] }
    await manager.reconcileAllCatalogs()

    expect(retained(manager, CAM_B, 'low')).toBe(0)
    expect(retained(manager, CAM_A, 'low')).toBe(20)
  })

  it('arms the PROFILE an ask names, in the same ask as the duration', async () => {
    answer = {
      kind: 'plan',
      rulesLoaded: true,
      asks: [{ ...WINDOW_ASK, profile: 'high' }],
    }
    await manager.reconcileAllCatalogs()

    // Both: the cut defaults to the cheapest, and the rule asked for `high`.
    expect(retained(manager, CAM_A, 'high')).toBe(20)
    expect(retained(manager, CAM_A, 'low')).toBe(20)
  })

  it('says so, per camera, when a camera’s retention moves', async () => {
    await manager.reconcileAllCatalogs()
    const first = lines.filter((l) => l.message.startsWith('clip retention'))
    expect(first.map((l) => [l.deviceId, l.seconds])).toEqual(
      expect.arrayContaining([
        [CAM_A, 20],
        [CAM_B, 60],
      ]),
    )

    // A tick that changes nothing says nothing — this runs every 30 s.
    lines.length = 0
    await manager.reconcileAllCatalogs()
    expect(lines.filter((l) => l.message.startsWith('clip retention'))).toEqual([])

    // …and the transition to zero is named.
    answer = { kind: 'plan', rulesLoaded: true, asks: [] }
    await manager.reconcileAllCatalogs()
    const off = lines.filter((l) => l.message.startsWith('clip retention'))
    expect(off.some((l) => l.deviceId === CAM_A && l.seconds === 0)).toBe(true)
    expect(off.every((l) => l.message.includes('none'))).toBe(true)
  })
})
