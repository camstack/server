/**
 * The pure pieces the addon wiring uses.
 *
 *  - lighting: `ir` for night/ir, `day` otherwise (decision 12);
 *  - the tape scene carries geometry and class lists, never a zone's NAME or
 *    colour (§3.2);
 *  - status: EVERY camera asked about gets a row, and a switched-off camera is
 *    reported `off` — never absent, never an error (D62, decision 9);
 *  - (Task 10) tapes are HUB-only (§3.1): an agent refuses by name even when
 *    it is the designated post-processing node, and so does a hub that is not.
 *
 * Disarms:
 *  - in `describeTapeStatus`, drop cameras whose switch is off — the "off is
 *    reported off" test must fail;
 *  - (amended 2026-09-29 for D683 R3) in `makeIdentityVerdictObserver`, read
 *    `sinks()` ONCE at construction instead of per call: "reaches a sink
 *    created AFTER the observer" fails;
 *  - (amended for D683 R3) drop the per-sink try/catch: "a throwing sink is
 *    logged and never stops the others" fails;
 *  - (Task 10) in `tapeNodeRefusal`, drop the `nodeId !== TAPE_NODE_ID` clause:
 *    "an agent refuses even as the post-processing node" fails;
 *  - (fix round, M2) report `rec === null` as `recording`: "a recorder that
 *    never started is failing, never recording" fails;
 *  - (fix round, M3) fold an unreadable listing into zero: "an unreadable
 *    shelf is null, never zero" fails;
 *  - (fix round, L4) drop the `switchUnreadable` branch: "a camera whose
 *    switch could not be read is unknown" fails;
 *  - (D681 follow-up) in `defaultTapeStatusCameras`, return the input unchanged:
 *    "default status drops an Off camera with nothing held" fails.
 */
import type { Zone, ZoneRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import type { FaceIdentityVerdict } from '../../../face-recognizer.js'
import { makeIdentityVerdictObserver } from '../identity-observer.js'
import { lightingFromCondition } from '../lighting.js'
import { tapeSceneOf } from '../tape-scene.js'
import { defaultTapeStatusCameras, describeTapeStatus, tapeNodeRefusal } from '../tape-status.js'

describe('lightingFromCondition', () => {
  it.each([
    ['night', 'ir'],
    ['ir', 'ir'],
    ['day', 'day'],
    ['dawn', 'day'],
    ['dusk', 'day'],
  ] as const)('%s → %s', (condition, lighting) => {
    expect(lightingFromCondition(condition)).toBe(lighting)
  })
})

describe('tapeSceneOf', () => {
  it('keeps geometry and class lists, drops names and colours', () => {
    const zones: Zone[] = [
      {
        id: 'z1',
        name: 'Aiuola',
        kind: 'polygon',
        polygon: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        color: '#fff',
      },
    ]
    const rules: ZoneRule[] = [
      {
        id: 'r1',
        name: 'Solo persone',
        zoneIds: ['z1'],
        mode: 'include',
        classFilter: ['person'],
        enabled: true,
      },
    ]
    const scene = tapeSceneOf(zones, rules, 0.1, 0.35)
    expect(scene).toEqual({
      zones: [
        {
          id: 'z1',
          kind: 'polygon',
          polygon: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      ],
      rules: [
        { id: 'r1', zoneIds: ['z1'], mode: 'include', classFilter: ['person'], enabled: true },
      ],
      zoneMembershipMinOverlap: 0.1,
      lowScoreFloor: 0.35,
    })
    expect(JSON.stringify(scene)).not.toContain('Aiuola')
  })
})

describe('describeTapeStatus', () => {
  const HOUR = 3_600_000
  const NOW = 1_800_000_000_000

  it('reports a switched-off camera as off', () => {
    const rows = describeTapeStatus({
      deviceIds: [101, 104],
      switchOn: new Map([
        [101, true],
        [104, false],
      ]),
      recorder: (deviceId) =>
        deviceId === 101
          ? {
              deviceId,
              state: 'recording',
              segmentOriginMs: NOW - 60_000,
              framesInSegment: 420,
              rawBytesInSegment: 1,
              framesSinceArmed: 4_200,
              gapsSinceArmed: 0,
              segmentsSinceArmed: 1,
              armedSinceMs: NOW - 10 * 60_000,
            }
          : null,
      refusal: null,
      segments: new Map([
        [
          101,
          {
            ok: true,
            unstatted: [],
            segments: [
              { deviceId: 101, originMs: NOW - 2 * HOUR, file: 'a', bytes: 1_000 },
              { deviceId: 101, originMs: NOW - 30 * 60_000, file: 'b', bytes: 500 },
            ],
          },
        ],
        [104, { ok: true, unstatted: [], segments: [] }],
      ]),
      now: NOW,
    })
    expect(rows.find((r) => r.deviceId === 104)).toMatchObject({ state: 'off', segmentsHeld: 0 })
    expect(rows.find((r) => r.deviceId === 101)).toMatchObject({
      state: 'recording',
      framesPerMin: 420,
      segmentsHeld: 2,
      bytesHeld: 1_500,
      bytesLastHour: 500,
      heldFromMs: NOW - 2 * HOUR,
    })
  })

  it('reports a switched-on camera on a refusing node as refused, with the reason', () => {
    const rows = describeTapeStatus({
      deviceIds: [102],
      switchOn: new Map([[102, true]]),
      recorder: () => null,
      refusal: 'artifacts-elsewhere',
      segments: new Map(),
      now: NOW,
    })
    expect(rows).toEqual([
      expect.objectContaining({ deviceId: 102, state: 'refused', reason: 'artifacts-elsewhere' }),
    ])
  })

  it('a recorder that never started is failing, never recording (M2)', () => {
    const base = {
      deviceIds: [101],
      switchOn: new Map([[101, true]]),
      recorder: () => null,
      refusal: null,
      segments: new Map(),
      now: NOW,
    }
    expect(describeTapeStatus(base)[0]).toMatchObject({
      state: 'failing',
      reason: 'tracking tapes not started',
    })
    expect(describeTapeStatus({ ...base, startFailure: 'EACCES' })[0]).toMatchObject({
      state: 'failing',
      reason: 'tracking tapes could not start: EACCES',
    })
  })

  it('an unreadable shelf is null, never zero (M3, D393)', () => {
    const [row] = describeTapeStatus({
      deviceIds: [101],
      switchOn: new Map([[101, false]]),
      recorder: () => null,
      refusal: null,
      segments: new Map([[101, { ok: false, reason: 'EACCES' }]]),
      now: NOW,
    })
    expect(row).toMatchObject({
      state: 'off',
      segmentsHeld: null,
      bytesHeld: null,
      bytesLastHour: null,
      shelfError: 'EACCES',
    })
    const [partial] = describeTapeStatus({
      deviceIds: [101],
      switchOn: new Map([[101, false]]),
      recorder: () => null,
      refusal: null,
      segments: new Map([[101, { ok: true, unstatted: [NOW - HOUR], segments: [] }]]),
      now: NOW,
    })
    expect(partial).toMatchObject({
      bytesHeld: null,
      shelfError: '1 segment file(s) could not be read',
    })
  })

  it('a camera whose switch could not be read is unknown, and the others still answer (L4)', () => {
    const rows = describeTapeStatus({
      deviceIds: [104, 101],
      switchOn: new Map([[101, false]]),
      switchUnreadable: new Map([[104, 'settings store timeout']]),
      recorder: () => null,
      refusal: null,
      segments: new Map(),
      now: NOW,
    })
    expect(rows.find((r) => r.deviceId === 104)).toMatchObject({
      state: 'unknown',
      reason: 'settings store timeout',
    })
    expect(rows.find((r) => r.deviceId === 101)).toMatchObject({ state: 'off' })
  })
})

describe('defaultTapeStatusCameras (D681 follow-up)', () => {
  it('default status drops an Off camera with nothing held', () => {
    const rows = describeTapeStatus({
      deviceIds: [104, 101, 102, 108],
      switchOn: new Map([
        [104, false],
        [101, true],
        [102, false],
        [618, false],
      ]),
      recorder: (deviceId) =>
        deviceId === 101
          ? {
              deviceId,
              state: 'recording',
              framesInSegment: 1,
              rawBytesInSegment: 1,
              framesSinceArmed: 1,
              gapsSinceArmed: 0,
              segmentsSinceArmed: 1,
            }
          : null,
      refusal: null,
      segments: new Map([
        [104, { ok: true, unstatted: [], segments: [] }],
        [101, { ok: true, unstatted: [], segments: [] }],
        [
          102,
          {
            ok: true,
            unstatted: [],
            segments: [{ deviceId: 102, originMs: 1, file: 'a', bytes: 10 }],
          },
        ],
        [618, { ok: false, reason: 'EACCES' }],
      ]),
      now: 1_800_000_000_000,
    })
    const narrowed = defaultTapeStatusCameras(rows)
    expect(narrowed.map((r) => r.deviceId)).toEqual([101, 102, 108])
    expect(narrowed.find((r) => r.deviceId === 104)).toBeUndefined()
  })
})

describe('tapeNodeRefusal (hub only, §3.1)', () => {
  it('the hub that post-processes records', () => {
    expect(tapeNodeRefusal({ nodeId: 'hub', isPostProcessingNode: true })).toBeNull()
  })

  it('a hub that does not post-process refuses by name', () => {
    expect(tapeNodeRefusal({ nodeId: 'hub', isPostProcessingNode: false })).toBe(
      'not-post-processing-node',
    )
  })

  it('an agent refuses even as the post-processing node — agents persist nothing', () => {
    expect(tapeNodeRefusal({ nodeId: 'mac-mini', isPostProcessingNode: true })).toBe(
      'not-post-processing-node',
    )
    expect(tapeNodeRefusal({ nodeId: 'agent-a', isPostProcessingNode: false })).toBe(
      'not-post-processing-node',
    )
  })
})

// (amended 2026-09-29 for D683 R3)
describe('makeIdentityVerdictObserver', () => {
  const verdict = (trackId: string, timestamp: number): FaceIdentityVerdict => ({
    deviceId: 101,
    trackId,
    timestamp,
    identityId: 'id-alice',
  })

  it('reaches a sink created AFTER the observer (the recorder is born after the recognizer)', () => {
    const { logger } = makeLogRecorder()
    const seen: string[] = []
    let sinks: ((v: FaceIdentityVerdict) => void)[] = []
    const observe = makeIdentityVerdictObserver(() => sinks, logger)
    observe(verdict('trk-1', 1000))
    sinks = [(v) => seen.push(`${v.trackId}@${String(v.timestamp)}`)]
    // Verdicts arrive late and out of frame order; the observer forwards them as they come.
    observe(verdict('trk-2', 3000))
    observe(verdict('trk-1', 2000))
    expect(seen).toEqual(['trk-2@3000', 'trk-1@2000'])
  })

  it('a throwing sink is logged and never stops the others or reaches the recognizer', () => {
    const { logger, entries } = makeLogRecorder()
    const seen: string[] = []
    const observe = makeIdentityVerdictObserver(
      () => [
        () => {
          throw new Error('disk full')
        },
        (v) => seen.push(v.trackId),
      ],
      logger,
    )
    expect(() => observe(verdict('trk-1', 1000))).not.toThrow()
    expect(seen).toEqual(['trk-1'])
    expect(
      entries.find((e) => e.message === 'identity verdict observer failed')?.extras?.tags,
    ).toEqual({ deviceId: 101 })
  })
})
