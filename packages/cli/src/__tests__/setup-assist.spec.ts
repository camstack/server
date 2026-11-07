import { describe, expect, it } from 'vitest'
import { setupBenchmark } from '../mcp/setup-benchmark.js'
import { setupLocations, setupLocationsApply, proposeLocations } from '../mcp/setup-locations.js'
import { setupPipelineApply } from '../mcp/setup-pipeline.js'
import { setupRecording, setupRecordingApply } from '../mcp/setup-recording.js'
import { setupStreams, setupStreamsApply } from '../mcp/setup-streams.js'
import { asProtectedTier, dryRunOf, gatedHub, writes } from './configure-fixtures.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const row = (id: string, extra: { [k: string]: unknown } = {}): { [k: string]: unknown } => ({
  id,
  type: id.split(':')[0],
  displayName: id,
  providerId: 'fs',
  config: { path: '/data/x' },
  nodeId: 'hub',
  isSystem: false,
  enabled: true,
  mode: 'active',
  createdAt: 1,
  updatedAt: 2,
  ...extra,
})

const storageAnswers = (rows: unknown): { [p: string]: unknown } => ({
  'storage.listLocations': rows,
  'storage.listLocationDeclarations': [],
  'storage.listDrainProgress': [],
})

describe('setup_locations', () => {
  it('reports an occupancy nobody measured as null, never 0', async () => {
    const { ctx } = gatedHub(
      storageAnswers([
        row('recordings:a', { owned: { bytes: 5, measuredAtMs: 9 } }),
        row('recordings:b'),
      ]),
    )
    const out = await setupLocations(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const locs = out.classes.flatMap((c) => c.locations)
    expect(locs.find((l) => l.id === 'recordings:a')?.ownedBytes).toBe(5)
    expect(locs.find((l) => l.id === 'recordings:b')?.ownedBytes).toBeNull()
    expect(locs.find((l) => l.id === 'recordings:b')?.capacity).toBeNull()
  })

  it('a failed locations read proposes nothing and says why', async () => {
    const { ctx } = gatedHub({ ...storageAnswers([]), 'storage.listLocations': new Error('boom') })
    const out = await setupLocations(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.unavailable['locations']).toContain('boom')
    expect(out.proposal.changes).toEqual([])
  })

  it('proposes re-enabling a read-only location when a class has no writer', () => {
    const proposal = proposeLocations([
      {
        type: 'recordings',
        displayName: null,
        cardinality: null,
        locations: [
          {
            id: 'recordings:a',
            displayName: 'a',
            providerId: 'fs',
            nodeId: 'hub',
            mode: 'readonly',
            capacity: null,
            ownedBytes: null,
            ownedMeasuredAtMs: null,
            drain: null,
          },
        ],
      },
    ])
    expect(proposal.changes).toEqual([
      expect.objectContaining({ locationId: 'recordings:a', mode: 'active' }),
    ])
  })

  it('apply: dry run writes nothing; the token patches the mode of the instance', async () => {
    const { ctx, calls } = gatedHub({
      ...storageAnswers([
        row('recordings:a', { mode: 'readonly', enabled: false }),
        row('recordings:b'),
      ]),
      'integrationInstances.updateInstance': {},
    })
    const args = { changes: [{ locationId: 'recordings:a', mode: 'active' as const }] }
    const dry = dryRunOf(await setupLocationsApply(ctx, args, undefined))
    expect(dry.token).toBeDefined()
    expect(writes(calls)).toHaveLength(0)
    await setupLocationsApply(ctx, args, dry.token)
    const w = writes(calls)
    expect(w).toHaveLength(1)
    expect(w[0]?.path).toBe('integrationInstances.updateInstance')
    expect(w[0]?.input).toEqual({
      addonId: 'storage-orchestrator',
      id: 'recordings:a',
      values: { mode: 'active' },
    })
  })

  it('apply: refuses a change that leaves a class with no writer, and a protected credential', async () => {
    const answers = {
      ...storageAnswers([row('recordings:a')]),
      'integrationInstances.updateInstance': {},
    }
    const { ctx, calls } = gatedHub(answers)
    const dry = await setupLocationsApply(
      ctx,
      { changes: [{ locationId: 'recordings:a', mode: 'disabled' }] },
      undefined,
    )
    expect(dryRunOf(dry).token).toBeUndefined()
    const prot = await asProtectedTier(ctx)
    const refused = await setupLocationsApply(
      prot,
      { changes: [{ locationId: 'recordings:a', mode: 'readonly' }] },
      undefined,
    )
    expect(JSON.stringify(refused)).toMatch(/admin/i)
    expect(writes(calls)).toHaveLength(0)
  })

  it('no session is reported, not thrown', async () => {
    const out = await setupLocations(noSessionContext())
    expect(out.status).not.toBe('ok')
  })
})

const cameras = [
  { id: 1, name: 'Front' },
  { id: 2, name: 'Back' },
]
const offConfig = { enabled: false, bands: [] }
const eventsConfig = {
  enabled: true,
  bands: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', mode: 'events' }],
}

describe('setup_recording', () => {
  it('proposes events for a camera recording nothing; unreadable config stays null', async () => {
    const { ctx } = gatedHub({
      'deviceManager.listAll': cameras,
      'pipelineOrchestrator.getCameraStatuses': [],
      'recordingArchive.getDeviceConfig': (input: unknown) => {
        if (
          typeof input === 'object' &&
          input !== null &&
          'deviceId' in input &&
          input.deviceId === 2
        ) {
          throw new Error('recorder gone')
        }
        return offConfig
      },
    })
    const out = await setupRecording(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.cameras.find((c) => c.deviceId === 2)?.config).toBeNull()
    expect(out.proposal.changes.map((c) => c.deviceId)).toEqual([1])
    expect(out.proposal.notes.join(' ')).toContain('unknown')
  })

  it('apply: invalid config is not confirmable; valid applies only with the token', async () => {
    const { ctx, calls } = gatedHub({
      'recordingArchive.getDeviceConfig': offConfig,
      'recordingArchive.setDeviceConfig': {},
    })
    const bad = await setupRecordingApply(
      ctx,
      { changes: [{ deviceId: 1, config: { enabled: true, bands: 'x' } }] },
      undefined,
    )
    expect(dryRunOf(bad).token).toBeUndefined()
    const args = { changes: [{ deviceId: 1, config: eventsConfig }] }
    const dry = dryRunOf(await setupRecordingApply(ctx, args, undefined))
    expect(dry.token).toBeDefined()
    expect(writes(calls)).toHaveLength(0)
    await setupRecordingApply(ctx, args, dry.token)
    expect(writes(calls).map((c) => c.path)).toEqual(['recordingArchive.setDeviceConfig'])
  })
})

const nativeStream = (id: string, w: number): { [k: string]: unknown } => ({
  camStreamId: id,
  deviceId: 1,
  kind: 'pull-rtsp',
  resolution: { width: w, height: Math.round((w * 9) / 16) },
})
const stats = (idr: number): { [k: string]: unknown } => ({
  status: 'streaming',
  inputFps: 15,
  encodedSubscribers: 1,
  uptimeMs: 1000,
  bitrateKbps: 900,
  idrIntervalMs: idr,
  totalBytes: 1,
  packetCount: 1,
  rtspClients: 0,
  pipeClients: 0,
  preBufferSec: 0,
  preBufferMs: 0,
  preBufferPackets: 0,
})
const streamAnswers = (statsAnswer: unknown): { [p: string]: unknown } => ({
  'deviceManager.listAll': [cameras[0]],
  'pipelineOrchestrator.getCameraStatuses': [],
  'recordingArchive.getDeviceConfig': offConfig,
  'streamBroker.listAllCameraStreams': [
    nativeStream('main', 2560),
    nativeStream('sub', 640),
    { ...nativeStream('derived:web-720p', 1280), kind: 'derived' },
  ],
  'streamBroker.listAllProfileSlots': [
    {
      deviceId: 1,
      profile: 'high',
      brokerId: '1/high',
      sourceCamStreamId: null,
      status: 'unassigned',
    },
    {
      deviceId: 1,
      profile: 'low',
      brokerId: '1/low',
      sourceCamStreamId: null,
      status: 'unassigned',
    },
  ],
  'streamBroker.getBrokerStats': statsAnswer,
  'streamBroker.assignProfile': {},
  'streamBroker.unassignProfile': {},
})

describe('setup_streams', () => {
  it('lists native and derived streams with stats; proposes largest to high, smallest to low', async () => {
    const { ctx } = gatedHub(streamAnswers(stats(1000)))
    const out = await setupStreams(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const cam = out.cameras[0]
    expect(cam?.native.map((s) => s.camStreamId)).toEqual(['main', 'sub'])
    expect(cam?.derived.map((s) => s.camStreamId)).toEqual(['derived:web-720p'])
    expect(cam?.native[0]?.stats?.bitrateKbps).toBe(900)
    expect(out.proposal.changes).toEqual([
      expect.objectContaining({ deviceId: 1, profile: 'high', camStreamId: 'main' }),
      expect.objectContaining({ deviceId: 1, profile: 'low', camStreamId: 'sub' }),
    ])
  })

  it('a failed getBrokerStats is stats null, never zeros', async () => {
    const { ctx } = gatedHub(streamAnswers(new Error('no such broker')))
    const out = await setupStreams(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.cameras[0]?.native[0]?.stats).toBeNull()
    expect(Object.keys(out.cameras[0]?.unavailable ?? {}).length).toBeGreaterThan(0)
  })

  it('apply: dry run writes nothing; token assigns; protected is refused', async () => {
    const { ctx, calls } = gatedHub(streamAnswers(stats(1000)))
    const args = { changes: [{ deviceId: 1, profile: 'high' as const, camStreamId: 'main' }] }
    const dry = dryRunOf(await setupStreamsApply(ctx, args, undefined))
    expect(JSON.stringify(dry.describe)).toMatch(/detection/i)
    expect(writes(calls)).toHaveLength(0)
    const prot = await asProtectedTier(ctx)
    expect(JSON.stringify(await setupStreamsApply(prot, args, undefined))).toMatch(/admin/i)
    await setupStreamsApply(ctx, args, dry.token)
    expect(writes(calls).map((c) => c.path)).toEqual(['streamBroker.assignProfile'])
  })
})

describe('setup_pipeline apply', () => {
  it('a plan that cannot be read is not confirmable and writes nothing', async () => {
    const { ctx, calls } = gatedHub({
      'pipelineOrchestrator.planAutoTune': new Error('planner down'),
      'pipelineOrchestrator.applyAutoTune': {},
    })
    const out = await setupPipelineApply(ctx, { planHash: 'abc' }, undefined)
    expect(dryRunOf(out).token).toBeUndefined()
    expect(writes(calls)).toHaveLength(0)
  })
})

describe('setup_benchmark', () => {
  it('without a session reports it', async () => {
    const out = await setupBenchmark(noSessionContext(), {})
    expect(out.status).not.toBe('ok')
  })

  it('a hub that answers nothing leaves the reasons, not an empty "all measured"', async () => {
    const { ctx } = fakeHub({})
    const out = await setupBenchmark(ctx, {})
    expect(JSON.stringify(out)).not.toContain('"proposal":{"runs":[]}')
  })
})
