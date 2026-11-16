/**
 * #451: `training_frame_candidates` finds instants a still object would show at
 * (not only tracks of the class) and `training_frame_mark` stages them through the
 * existing retrain API behind the mutation gate, with a normalised zone.
 */
import type { HubClient } from '@camstack/develop'
import { MutationGate, parseApiIndex } from '@camstack/develop'
import { describe, expect, it } from 'vitest'
import {
  ADD_FRAME_PATH,
  ASSIST_PATH,
  assistVerdict,
  TrainingMarkArgsSchema,
  trainingFrameMark,
} from '../models/training-mark.js'
import { createGatedMutator } from '../ops/hub.js'
import { planCandidates, trainingFrameCandidates } from '../ops/training-candidates.js'
import { fakeHub, fakeMutator } from './model-fakes.js'

const MIN = 60_000
const T0 = 1_800_000_000_000

function track(id: string, className: string, startMin: number, endMin: number, source = 'video') {
  return {
    trackId: id,
    deviceId: 615,
    className,
    source,
    firstSeen: T0 + startMin * MIN,
    lastSeen: T0 + endMin * MIN,
    state: 'ended',
    active: false,
  }
}

const COURIER = track('courier-track-0001', 'person', 0, 2)

describe('planCandidates', () => {
  const base = {
    className: 'package',
    fromMs: T0 - 10 * MIN,
    toMs: T0 + 30 * MIN,
    afterMs: 30_000,
    sweepMs: 5 * MIN,
  }

  it('finds the still package: instants after the courier leaves and through the quiet stretch', () => {
    const planned = planCandidates({ ...base, tracks: [COURIER as never] })
    expect(planned.map((c) => c.kind)).toEqual(['after-actor', ...Array(5).fill('idle-sweep')])
    expect(planned[0]?.epochMs).toBe(COURIER.lastSeen + 30_000)
    // no track of the class exists, yet the stretch is covered
    expect(planned.some((c) => c.kind === 'class-track')).toBe(false)
  })

  it('stops the sweep at the next actor and keeps a track of the class', () => {
    const pickup = track('pickup-track-00001', 'person', 12, 13)
    const box = track('package-track-0001', 'package', 3, 5)
    const planned = planCandidates({ ...base, tracks: [COURIER, pickup, box] as never })
    const courierSweeps = planned.filter(
      (c) => c.trackId === COURIER.trackId && c.kind === 'idle-sweep',
    )
    expect(courierSweeps.length).toBeGreaterThan(0)
    expect(courierSweeps.every((c) => c.epochMs < pickup.firstSeen)).toBe(true)
    expect(planned.filter((c) => c.kind === 'class-track')).toHaveLength(1)
  })

  it('ignores audio and switch tracks as actors', () => {
    const noise = [
      track('a-track-0000001', 'speech', 0, 1, 'audio'),
      track('s-track-0000001', 'switch', 0, 1),
    ]
    expect(planCandidates({ ...base, tracks: noise as never })).toEqual([])
  })
})

describe('trainingFrameCandidates', () => {
  const answers = (recordingRanges: { startMs: number; endMs: number }[]) => ({
    'pipelineAnalytics.listRecentTracks': { tracks: [COURIER], nextCursor: null },
    'recording.listSources': [{ source: 'camstack', addonId: 'recorder' }],
    'recording.getAvailability': {
      read: 'read',
      ranges: recordingRanges.map((r) => ({ profile: 'high', ...r })),
    },
  })

  it('drops instants that are not on a recording and says how many', async () => {
    // footage stops 8 minutes after the courier left
    const hub = fakeHub(answers([{ startMs: T0 - 5 * MIN, endMs: T0 + 10 * MIN }]))
    const out = (await trainingFrameCandidates(hub, {
      deviceId: 615,
      fromMs: T0 - 10 * MIN,
      toMs: T0 + 30 * MIN,
    })) as { candidates: { kind: string }[]; recording: { droppedNotOnRecording: number } }
    expect(out.candidates.map((c) => c.kind)).toEqual(['after-actor', 'idle-sweep'])
    expect(out.recording.droppedNotOnRecording).toBe(4)
  })

  it('does not claim footage when the recorder could not be read', async () => {
    const hub = fakeHub({
      ...answers([]),
      'recording.getAvailability': { read: 'unreadable', ranges: [] },
    })
    const out = (await trainingFrameCandidates(hub, {
      deviceId: 615,
      fromMs: T0 - 10 * MIN,
      toMs: T0 + 30 * MIN,
    })) as { recording: { read: boolean }; candidates: unknown[] }
    expect(out.recording.read).toBe(false)
    expect(out.candidates.length).toBeGreaterThan(0)
  })

  it('caps the list', async () => {
    const hub = fakeHub(answers([{ startMs: T0 - 5 * MIN, endMs: T0 + 40 * MIN }]))
    const out = (await trainingFrameCandidates(hub, {
      deviceId: 615,
      fromMs: T0 - 10 * MIN,
      toMs: T0 + 30 * MIN,
      maxCandidates: 2,
    })) as { candidates: unknown[]; candidatesTotal: number }
    expect(out.candidates).toHaveLength(2)
    expect(out.candidatesTotal).toBeGreaterThan(2)
  })
})

describe('training_frame_mark', () => {
  const gate = () => new MutationGate({ allowMutations: true })
  const hubAnswers = {
    'pipelineAnalytics.listRetrainCollections': [{ id: 'c-pacchi', name: 'Pacchi', frameCount: 2 }],
    'recording.listSources': [{ source: 'camstack', addonId: 'recorder' }],
    'recording.getAvailability': {
      read: 'read',
      ranges: [{ profile: 'high', startMs: T0 - 5 * MIN, endMs: T0 + 5 * MIN }],
    },
  }
  const ZONE = { x: 0.1, y: 0.5, w: 0.3, h: 0.3 }
  const args = { deviceId: 615, collection: 'pacchi', epochMs: [T0, T0 + 20 * MIN], zone: ZONE }

  it('refuses a pixel zone: it silently returns zero proposals', () => {
    expect(
      TrainingMarkArgsSchema.safeParse({ ...args, zone: { x: 120, y: 480, w: 200, h: 200 } })
        .success,
    ).toBe(false)
    expect(
      TrainingMarkArgsSchema.safeParse({ ...args, zone: { x: 0.8, y: 0, w: 0.5, h: 0.5 } }).success,
    ).toBe(false)
    expect(TrainingMarkArgsSchema.safeParse(args).success).toBe(true)
  })

  it('a dry run names the collection and which instants are on a recording, and writes nothing', async () => {
    const mutator = fakeMutator()
    const r = await trainingFrameMark(
      { gate: gate(), hub: () => fakeHub(hubAnswers), mutator: () => mutator },
      TrainingMarkArgsSchema.parse(args),
      undefined,
    )
    expect(r.status).toBe('dry-run')
    const text = JSON.stringify(r)
    expect(text).toContain('c-pacchi')
    expect(text).toMatch(/"onRecording":true/)
    expect(text).toMatch(/"onRecording":false/)
    expect(mutator.calls).toHaveLength(0)
  })

  it('an unknown collection is not confirmable and nothing is created', async () => {
    const mutator = fakeMutator()
    const r = await trainingFrameMark(
      { gate: gate(), hub: () => fakeHub(hubAnswers), mutator: () => mutator },
      TrainingMarkArgsSchema.parse({ ...args, collection: 'nope' }),
      undefined,
    )
    expect('confirm_token' in r).toBe(false)
    expect(JSON.stringify(r)).toMatch(/no retrain collection/)
    expect(mutator.calls).toHaveLength(0)
  })

  it('the confirmed call adds each still, runs the package assist in the zone and reports the verdict', async () => {
    const g = gate()
    const mutator = fakeMutator({
      [ADD_FRAME_PATH]: { kind: 'added', reused: false, frame: { frameId: 'retrain:rec:615:aaa' } },
      [ASSIST_PATH]: {
        kind: 'proposed',
        modelId: 'rfdetr-package',
        stepId: 's',
        minScore: 0.35,
        belowThreshold: 0,
        proposals: [],
      },
    })
    const deps = { gate: g, hub: () => fakeHub(hubAnswers), mutator: () => mutator }
    const parsed = TrainingMarkArgsSchema.parse(args)
    const dry = await trainingFrameMark(deps, parsed, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    const done = await trainingFrameMark(deps, parsed, dry.confirm_token)
    expect(done.status).toBe('executed')
    expect(mutator.calls.map((c) => c.path)).toEqual([
      ADD_FRAME_PATH,
      ASSIST_PATH,
      ADD_FRAME_PATH,
      ASSIST_PATH,
    ])
    expect(mutator.calls[0]?.input).toEqual({
      collectionId: 'c-pacchi',
      deviceId: 615,
      epochMs: T0,
    })
    expect(mutator.calls[1]?.input).toEqual({
      deviceId: 615,
      frameId: 'retrain:rec:615:aaa',
      subject: { kind: 'package', zone: ZONE },
    })
    expect(JSON.stringify(done)).toContain('model-miss')
    // never saves an annotation: the operator confirms the drafts
    expect(mutator.calls.some((c) => c.path.includes('saveRetrainAnnotations'))).toBe(false)
  })

  it('names a refused still and skips its assist', async () => {
    const g = gate()
    const mutator = fakeMutator({
      [ADD_FRAME_PATH]: { kind: 'refused', reason: 'still-unavailable', detail: 'no footage' },
    })
    const deps = { gate: g, hub: () => fakeHub(hubAnswers), mutator: () => mutator }
    const parsed = TrainingMarkArgsSchema.parse({ ...args, epochMs: [T0] })
    const dry = await trainingFrameMark(deps, parsed, undefined)
    if (dry.status !== 'dry-run' || !dry.confirm_token) throw new Error('no token')
    const done = await trainingFrameMark(deps, parsed, dry.confirm_token)
    expect(JSON.stringify(done)).toContain('still-unavailable')
    expect(mutator.calls).toHaveLength(1)
  })

  it('assistVerdict separates a model miss from a below-threshold detection', () => {
    const proposed = { kind: 'proposed' as const, minScore: 0.35, proposals: [] }
    expect(assistVerdict({ ...proposed, belowThreshold: 0 })).toBe('model-miss')
    expect(assistVerdict({ ...proposed, belowThreshold: 2 })).toBe('below-threshold')
    expect(assistVerdict({ kind: 'refused', reason: 'no-zone' })).toBe('assist-refused')
  })

  it('the mutator allow-list admits exactly these two retrain methods', async () => {
    const index = parseApiIndex(
      [
        `| \`${ADD_FRAME_PATH}\` | mutation | admin | pipeline-analytics |`,
        `| \`${ASSIST_PATH}\` | mutation | admin | pipeline-analytics |`,
        '| `pipelineAnalytics.saveRetrainAnnotations` | mutation | admin | pipeline-analytics |',
      ].join('\n'),
    )
    const sent: string[] = []
    const client: HubClient = {
      async call(_m, p) {
        sent.push(p)
        return {}
      },
    }
    const mutator = createGatedMutator({ server: 'https://h.test', tier: 'admin', index, client })
    await mutator.mutate(ADD_FRAME_PATH, { deviceId: 1, collectionId: 'c', epochMs: 1 })
    await mutator.mutate(ASSIST_PATH, { deviceId: 1, frameId: 'f' })
    await expect(
      mutator.mutate('pipelineAnalytics.saveRetrainAnnotations', { deviceId: 1 }),
    ).rejects.toThrow(/not an allow-listed/)
    expect(sent).toEqual([ADD_FRAME_PATH, ASSIST_PATH])
  })
})
