import { describe, expect, it } from 'vitest'
import type { OpsHub } from '../ops/hub.js'
import { hubLogs, selectLogSource } from '../ops/logs.js'
import { lokiQuery, type FetchLike } from '../ops/loki.js'
import { modelPinCensus, pinsIn, retrainCensus } from '../ops/censuses.js'
import { analyzeTrack, qualifiesForFace } from '../ops/track-audit.js'
import { capProviders, topology } from '../ops/curated.js'
import { TrackSchema, type MediaInfo, type Track } from '../ops/wire.js'

interface FakeHub extends OpsHub {
  readonly calls: { path: string; input: unknown }[]
}

function fakeHub(
  answers: Record<string, unknown | (() => unknown)>,
  tier: 'admin' | 'protected' = 'admin',
): FakeHub {
  const calls: { path: string; input: unknown }[] = []
  return {
    server: 'https://hub.example.test',
    tier,
    source: 'session',
    adminHint: null,
    calls,
    async query(p, input) {
      calls.push({ path: p, input })
      if (!(p in answers)) throw new Error(`unexpected query ${p}`)
      const a = answers[p]
      return typeof a === 'function' ? a() : a
    },
    async download() {
      throw new Error('no download in this fake')
    },
  }
}

describe('selectLogSource — the provider is chosen, never assumed', () => {
  const providers = [
    { addonId: 'winston-logging', isActive: true },
    { addonId: 'loki-logging', isActive: true },
  ]
  it('asks when nothing is named', () => {
    expect(selectLogSource(providers, undefined)).toEqual({
      kind: 'choose',
      options: ['ring', 'winston-logging', 'loki-logging'],
    })
  })
  it('accepts the ring and a configured provider, rejects anything else', () => {
    expect(selectLogSource(providers, 'ring')).toEqual({ kind: 'ring' })
    expect(selectLogSource(providers, 'winston-logging')).toEqual({
      kind: 'provider',
      addonId: 'winston-logging',
    })
    expect(selectLogSource(providers, 'grafana').kind).toBe('unknown')
  })
  it('offers only the ring plus what is configured: no Loki on a hub without it', () => {
    const only = selectLogSource([{ addonId: 'winston-logging', isActive: true }], undefined)
    expect(only).toEqual({ kind: 'choose', options: ['ring', 'winston-logging'] })
  })
})

describe('hub_logs', () => {
  const providers = [{ addonId: 'winston-logging', isActive: true }]

  it('queries NOTHING until a provider is named', async () => {
    const hub = fakeHub({ 'addons.listCapabilityProviders': providers })
    const out = await hubLogs(hub, {})
    expect(JSON.stringify(out)).toContain('Which log source')
    expect(hub.calls.map((c) => c.path)).toEqual(['addons.listCapabilityProviders'])
  })

  it('reads the ring and a provider through logs.query with its source (D898)', async () => {
    const hub = fakeHub({
      'addons.listCapabilityProviders': providers,
      'logs.query': { entries: [{ message: 'a line' }], nextBefore: null, done: true },
    })
    await hubLogs(hub, { provider: 'ring', deviceId: 102 }, 1_000_000)
    await hubLogs(hub, { provider: 'winston-logging', level: 'error' }, 1_000_000)
    const [ring, dest] = hub.calls.filter((c) => c.path === 'logs.query')
    expect(ring?.input).toMatchObject({ source: 'ring', tags: { deviceId: '102' } })
    expect(dest?.input).toMatchObject({ source: 'winston-logging', level: 'error' })
    expect(dest?.input).toHaveProperty('since')
  })

  it('refuses a provider the hub does not have instead of falling back to another', async () => {
    const hub = fakeHub({ 'addons.listCapabilityProviders': providers })
    const out = await hubLogs(hub, { provider: 'loki-logging' })
    expect(JSON.stringify(out)).toContain('unknown log provider')
    expect(hub.calls.map((c) => c.path)).toEqual(['addons.listCapabilityProviders'])
  })
})

describe('loki_query — only where a Loki provider is configured', () => {
  const lokiSettings = (fields: Record<string, unknown>) => ({
    sections: [{ fields: Object.entries(fields).map(([key, value]) => ({ key, value })) }],
  })
  const okFetch: FetchLike & { urls: string[] } = Object.assign(
    async (url: string) => {
      okFetch.urls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: { result: [{ stream: { job: 'camstack' }, values: [['1', 'a line']] }] },
          }),
      }
    },
    { urls: [] as string[] },
  )

  it('says so when the hub has no Loki provider (no Grafana assumed)', async () => {
    const hub = fakeHub({ 'addons.listCapabilityProviders': [{ addonId: 'winston-logging' }] })
    const out = await lokiQuery(hub, { logql: '{job="camstack"}' }, okFetch)
    expect(JSON.stringify(out)).toMatch(/no Loki log-destination provider/)
    expect(okFetch.urls).toHaveLength(0)
  })

  it('treats an empty URL as inert', async () => {
    const hub = fakeHub({
      'addons.listCapabilityProviders': [{ addonId: 'loki-logging' }],
      'addonSettings.getGlobalSettings': lokiSettings({ url: '' }),
    })
    expect(JSON.stringify(await lokiQuery(hub, { logql: '{}' }, okFetch))).toMatch(/inert/)
  })

  it('refuses an authenticated Loki rather than reading keychain credentials', async () => {
    const hub = fakeHub({
      'addons.listCapabilityProviders': [{ addonId: 'loki-logging' }],
      'addonSettings.getGlobalSettings': lokiSettings({
        url: 'https://loki.example.test',
        username: 'ops',
        password: { $secret: 'secret://loki-logging/global/password', v: 1, set: true },
      }),
    })
    const out = JSON.stringify(await lokiQuery(hub, { logql: '{}' }, okFetch))
    expect(out).toMatch(/credentials/)
    expect(okFetch.urls).toHaveLength(0)
  })

  it('queries the configured URL for an unauthenticated Loki', async () => {
    const hub = fakeHub({
      'addons.listCapabilityProviders': [{ addonId: 'loki-logging' }],
      'addonSettings.getGlobalSettings': lokiSettings({ url: 'https://loki.example.test/' }),
    })
    const out = JSON.stringify(await lokiQuery(hub, { logql: '{job="camstack"}' }, okFetch))
    expect(okFetch.urls[0]).toMatch(/^https:\/\/loki\.example\.test\/loki\/api\/v1\/query_range\?/)
    expect(out).toContain('a line')
  })
})

describe('curated reads degrade by tier instead of pretending', () => {
  it('topology without an admin credential says the list is incomplete', async () => {
    const hub = fakeHub({ 'system.info': { version: '1' } }, 'protected')
    const out = JSON.stringify(await topology(hub))
    expect(out).toContain('"complete":false')
    expect(hub.calls.map((c) => c.path)).toEqual(['system.info'])
  })
  it('topology reports a scope-limited session as refused, not as an empty cluster', async () => {
    const hub = fakeHub(
      {
        'system.info': () => {
          throw new Error("No scope grants view on 'system'")
        },
      },
      'protected',
    )
    const out = JSON.stringify(await topology(hub))
    expect(out).toContain('"complete":false')
    expect(out).toContain('systemInfoRefused')
  })
  it('cap_providers adds the registry view only for admin', async () => {
    const answers = {
      'addons.listCapabilityProviders': [{ addonId: 'a', isActive: true }],
      'capabilities.getCapability': { active: 'a' },
    }
    const admin = fakeHub(answers, 'admin')
    const prot = fakeHub(answers, 'protected')
    await capProviders(admin, 'recording')
    await capProviders(prot, 'recording')
    expect(admin.calls.map((c) => c.path)).toContain('capabilities.getCapability')
    expect(prot.calls.map((c) => c.path)).not.toContain('capabilities.getCapability')
  })
})

function track(over: Record<string, unknown> = {}): Track {
  return TrackSchema.parse({
    trackId: 'abcdef123456',
    deviceId: 101,
    className: 'person',
    firstSeen: 0,
    lastSeen: 10_000,
    state: 'confirmed',
    active: false,
    positions: [
      { timestamp: 0, bbox: { x: 100, y: 100, w: 50, h: 100 } },
      { timestamp: 5_000, bbox: { x: 300, y: 100, w: 50, h: 100 } },
      { timestamp: 10_000, bbox: { x: 500, y: 100, w: 50, h: 100 } },
    ],
    ...over,
  })
}

const media = (kind: string, timestamp: number, sizeBytes = 100): MediaInfo => ({
  mediaId: timestamp,
  kind,
  sizeBytes,
  timestamp,
})

const codes = (input: Parameters<typeof analyzeTrack>[0]): string[] =>
  analyzeTrack(input).map((f) => f.code)

const base = { siblings: [] as Track[], ffEqualsLf: null, enrichment: { face: null, plate: null } }

describe('analyzeTrack — the audit rules', () => {
  it('flags a track with no media at all', () => {
    expect(codes({ ...base, track: track(), media: [] })).toContain('ZERO_MEDIA')
  })
  it('flags the missing contract kinds of a closed track', () => {
    const c = codes({ ...base, track: track(), media: [media('crop', 100)] })
    expect(c).toEqual(
      expect.arrayContaining(['MISSING_FIRSTFRAME', 'MISSING_LASTFRAME', 'MISSING_THUMBNAIL']),
    )
  })
  it('flags a stale lastFrame and captures that stopped early', () => {
    const c = codes({
      ...base,
      track: track(),
      media: [media('firstFrame', 100), media('lastFrame', 3_000), media('thumbnail', 200)],
    })
    expect(c).toEqual(expect.arrayContaining(['LASTFRAME_STALE', 'MEDIA_STOPPED_EARLY']))
  })
  it('a healthy closed track has no media findings', () => {
    const c = codes({
      ...base,
      track: track(),
      media: [media('firstFrame', 100), media('lastFrame', 9_500), media('thumbnail', 5_000)],
    })
    expect(c).not.toContain('ZERO_MEDIA')
    expect(c).not.toContain('MISSING_THUMBNAIL')
    expect(c).not.toContain('LASTFRAME_STALE')
  })
  it('reports unreadable media as unknown, never as absent', () => {
    expect(codes({ ...base, track: track(), media: null })).toEqual(['MEDIA_UNREADABLE'])
  })
  it('flags a bigger in-frame shot that existed after the thumbnail', () => {
    const t = track({
      positions: [
        { timestamp: 0, bbox: { x: 100, y: 100, w: 20, h: 40 } },
        { timestamp: 1_000, bbox: { x: 150, y: 100, w: 20, h: 40 } },
        { timestamp: 5_000, bbox: { x: 300, y: 100, w: 100, h: 200 } },
      ],
    })
    const c = codes({
      ...base,
      track: t,
      media: [media('firstFrame', 0), media('lastFrame', 9_900), media('thumbnail', 500)],
    })
    expect(c).toContain('BEST_SHOT_STALE')
  })
  it('flags first == last, an expected-but-missing face, and a never-confirmed fragment', () => {
    expect(
      codes({
        ...base,
        track: track(),
        media: [media('firstFrame', 0), media('lastFrame', 9_900), media('thumbnail', 5_000)],
        ffEqualsLf: true,
      }),
    ).toContain('FF_EQ_LF')
    expect(
      codes({
        ...base,
        track: track(),
        media: [media('firstFrame', 0), media('lastFrame', 9_900), media('thumbnail', 5_000)],
        enrichment: { face: 'missing', plate: null },
      }),
    ).toContain('FACE_EXPECTED_MISSING')
    const frag = track({ lastSeen: 1_000, state: 'entered' })
    expect(codes({ ...base, track: frag, media: [media('crop', 100)] })).toContain(
      'FRAGMENT_SUSPECT',
    )
  })
  it('only probes faces on configured cameras for long enough person tracks', () => {
    expect(qualifiesForFace(track(), new Set([101]))).toBe(true)
    expect(qualifiesForFace(track(), new Set([102]))).toBe(false)
    expect(qualifiesForFace(track({ lastSeen: 1_000 }), new Set([101]))).toBe(false)
  })
})

describe('censuses — a failed read is never "nothing found"', () => {
  it('pinsIn matches the quoted id only', () => {
    expect(pinsIn('x', { modelId: 'yolo-a' }, ['yolo-a', 'yolo'])).toEqual([
      { where: 'x', modelId: 'yolo-a' },
    ])
  })

  const orchestrator = {
    sections: [{ fields: [{ key: 'clusterModel:detector', value: 'pinned-model' }] }],
  }
  const happy = {
    'nodes.directory': { complete: true, nodes: [{ id: 'hub', isOnline: true }] },
    'pipelineOrchestrator.getNodeInferenceDevices': { devices: [] },
    'pipelineOrchestrator.listAgentSettings': [],
    'customModelRegistry.listModels': [],
    'addonSettings.getGlobalSettings': orchestrator,
  }

  it('reports the pin and where it was found', async () => {
    const out = JSON.stringify(await modelPinCensus(fakeHub(happy), ['pinned-model']))
    expect(out).toContain('"pinned":true')
    expect(out).toContain('cluster row clusterModel:detector')
  })
  it('reads pins where they are stored, never a node-wide computed tree (D927)', async () => {
    const hub = fakeHub(happy)
    await modelPinCensus(hub, ['m'])
    expect(hub.calls.map((c) => c.path)).not.toContain('pipelineExecutor.getGlobalSteps')
  })
  it('throws when the node list is incomplete', async () => {
    const hub = fakeHub({ ...happy, 'nodes.directory': { complete: false, nodes: [] } })
    await expect(modelPinCensus(hub, ['m'])).rejects.toThrow(/proves nothing/)
  })
  it('throws when a read fails, instead of answering "not pinned"', async () => {
    const hub = fakeHub({
      ...happy,
      'customModelRegistry.listModels': () => {
        throw new Error('hub busy')
      },
    })
    await expect(modelPinCensus(hub, ['m'])).rejects.toThrow(/hub busy/)
  })
  it('throws when the cluster rows vanished (shape change)', async () => {
    const hub = fakeHub({ ...happy, 'addonSettings.getGlobalSettings': { sections: [] } })
    await expect(modelPinCensus(hub, ['m'])).rejects.toThrow(/shape changed/)
  })
  it('retrain census marks a partial frame read', async () => {
    const hub = fakeHub({
      'pipelineAnalytics.listRetrainStaging': [
        { trackId: 'a', className: 'person', deviceId: 1, annotationCount: 2 },
        { trackId: 'b', className: 'dog', deviceId: 1, annotationCount: 1 },
      ],
      'pipelineAnalytics.listRetrainFrames': { copies: [1], candidates: [1, 2] },
      'pipelineAnalytics.countUnstampedEventMedia': null,
      'customModelRegistry.listModels': [],
    })
    const out = JSON.stringify(await retrainCensus(hub, { maxFrameReads: 1 }))
    expect(out).toContain('"partial":true')
    expect(out).toContain('"annotations":3')
  })
})
