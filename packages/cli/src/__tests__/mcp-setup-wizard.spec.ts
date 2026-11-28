import { describe, expect, it } from 'vitest'
import { MutationGate, isSecretBearing } from '@dominevo/develop'
import { z } from 'zod'
import type { McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'
import { setupCoreAddons } from '../mcp/setup-core-addons.js'
import { STEP_EVALUATORS } from '../onboarding/evaluators.js'
import { bundledManifest, bundledOnly, type ManifestProvider } from '../onboarding/manifest.js'
import { memoryStateStore, type RememberedFeasibility } from '../onboarding/state-file.js'
import { notificationTargetAnswers } from './configure-fixtures.js'
import {
  N100,
  UNMEASURED_CPU,
  callJson,
  connectPublic,
  fakeHost,
  fakeHub,
  linuxHost,
  type HubAnswers,
} from './onboarding-fixtures.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const Action = z.object({
  id: z.string(),
  tool: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
  manual: z
    .object({
      text: z.string(),
      ui: z.object({ route: z.string() }).optional(),
    })
    .optional(),
})
const Detail = z.object({
  id: z.string(),
  page: z.string(),
  status: z.string(),
  startWith: z.string().nullable(),
  actions: z.array(Action),
})
const Answer = z.object({
  status: z.literal('ok'),
  manifest: z.object({
    source: z.string(),
    revision: z.number(),
    note: z.string().nullable(),
  }),
  state: z.object({
    phase: z.string(),
    hub: z.string().nullable(),
    tier: z.string().nullable(),
    verdict: z
      .object({
        kind: z.string(),
        answer: z.string().nullable(),
        cameras: z.number().nullable(),
        hubCapacity: z.number().optional(),
        limitedBy: z.string().nullable().optional(),
      })
      .nullable(),
  }),
  steps: z.array(
    z.object({
      id: z.string(),
      phase: z.string(),
      status: z.string(),
      detail: z.string(),
      reason: z.string().optional(),
    }),
  ),
  nextStep: Detail.nullable(),
  requestedStep: Detail.optional(),
  hardwareReport: z.object({ url: z.string() }).nullable(),
  notices: z.array(z.string()),
  unavailable: z.record(z.string(), z.string()),
})
type Answer = z.infer<typeof Answer>

const MANIFEST = bundledManifest()
const SEEDED = MANIFEST.coreAddons.filter((g) => g.need === 'seeded').flatMap((g) => g.addons)

const location = (id: string, extra: { [k: string]: unknown } = {}): { [k: string]: unknown } => ({
  id,
  type: id.split(':')[0],
  displayName: id,
  providerId: 'filesystem-storage',
  config: { basePath: `/data/${id}` },
  nodeId: 'hub',
  isSystem: false,
  enabled: true,
  mode: 'active',
  createdAt: 1,
  updatedAt: 2,
  ...extra,
})

const node = (nodeId: string, decode: number, detection: number): { [k: string]: unknown } => ({
  nodeId,
  detection: { maxSessions: detection, measuredAtMs: 5, cells: [] },
  decode: {
    maxStreams: decode,
    measuredAtMs: 5,
    profile: { width: 3840, height: 2160, fps: 15, codec: 'h265' },
    hardware: true,
    decoder: 'vaapi',
  },
  capacity: Math.min(decode, detection),
  limitedBy: decode <= detection ? 'decode' : 'detection',
  complete: true,
})

const EVENTS_EVERY_DAY = {
  enabled: true,
  bands: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', mode: 'events' }],
}

const nativeStream = (deviceId: number, id: string, width: number): { [k: string]: unknown } => ({
  camStreamId: id,
  deviceId,
  kind: 'pull-rtsp',
  resolution: { width, height: Math.round((width * 9) / 16) },
})

const slot = (
  deviceId: number,
  profile: 'high' | 'low',
  source: string | null,
): { [k: string]: unknown } => ({
  deviceId,
  profile,
  brokerId: `${deviceId}/${profile}`,
  sourceCamStreamId: source,
  status: source === null ? 'unassigned' : 'streaming',
})

const TARGETS = notificationTargetAnswers([
  {
    id: 't1',
    name: 'Phone',
    kind: 'push',
    enabled: true,
    config: { token: 'SECRET-TARGET-TOKEN' },
  },
])

/** A hub with everything set up, one agent, and both planes measured. */
const HEALTHY: HubAnswers = {
  'userManagement.listUsers': [
    {
      id: 'u1',
      username: 'root',
      isAdmin: true,
      totpEnabled: true,
      passwordHash: 'SECRET-HASH',
    },
  ],
  'userPasskeys.listPasskeys': [],
  'userManagement.getAdminBootstrapStatus': { defaultPasswordInUse: false },
  'localNetwork.getAddresses': {
    roles: { publicEndpoint: { resolved: 'https://hub.example.test' } },
  },
  'networkAccess.getStatus': { connected: true, endpoint: { stable: true } },
  'backup.listDestinations': [
    {
      id: 'a:b',
      enabled: true,
      cron: '0 3 * * *',
      lastSuccessAt: 1_700_000_000_000,
    },
  ],
  'deviceManager.listAll': [{ id: 7, name: 'Door' }],
  'recordingArchive.getDeviceConfig': EVENTS_EVERY_DAY,
  'streamBroker.listAllCameraStreams': [nativeStream(7, 'main', 2560), nativeStream(7, 'sub', 640)],
  'streamBroker.listAllProfileSlots': [slot(7, 'high', 'main'), slot(7, 'low', 'sub')],
  'nodes.topology': [
    { id: 'hub', isHub: true, isOnline: true },
    { id: 'agent1', isHub: false, isOnline: true },
  ],
  ...TARGETS,
  'integrationInstances.listInstances': (input: unknown) => {
    const { addonId } = z.object({ addonId: z.string() }).parse(input)
    if (addonId === 'notifiers') return TARGETS['integrationInstances.listInstances']
    return [{ id: `${addonId}-1`, enabled: true, status: { state: 'ok' } }]
  },
  'notificationRules.listRules': {
    rules: [
      {
        enabled: true,
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-offline'] } },
      },
      { enabled: true, delivery: 'immediate', conditions: { devices: [7] } },
    ],
  },
  'storage.listLocations': [location('recordings:disk2')],
  'addons.list': [...SEEDED.map((a) => a.id), 'provider-onvif', 'cloudflare-turn'].map((id) => ({
    manifest: { id, packageName: 'x', packageVersion: '1.0.0' },
  })),
  'pipelineOrchestrator.getNodeCapacityVerdict': [node('hub', 6, 9), node('agent1', 4, 4)],
  'serverManagement.getServerPackageStatus': {
    runningVersion: '1.0.0',
    latestVersion: '1.0.0',
  },
  'addons.listUpdates': [],
}

const REMEMBERED: RememberedFeasibility = {
  atMs: 1,
  verdict: 'hub-plus-agents',
  cameras: 8,
  hardwareClass: 'intel-n-series',
  measured: true,
  cpuModel: N100,
  accelerators: ['intel-gpu'],
  reasons: ['CPU alone was never measured'],
}

function noHub(extra: Partial<McpContext> = {}): McpContext {
  return {
    cliVersion: '9.9.9',
    hub: async () => ({
      ok: false,
      reason: 'no-session',
      message: 'no usable hub session: no hub address',
      action: 'run `dominevo login <host>` in a terminal',
    }),
    gate: new MutationGate({ allowMutations: true, audit: () => {} }),
    fetch: async () => new Response(JSON.stringify({ version: '9.9.9' })),
    manifest: bundledOnly,
    onboardingState: memoryStateStore(),
    host: fakeHost(linuxHost(N100, true)),
    ...extra,
  }
}

async function wizard(ctx: McpContext, args: Record<string, unknown> = {}): Promise<Answer> {
  return Answer.parse(await callJson(await connectPublic(ctx), 'setup_wizard', args))
}

const step = (answer: Answer, id: string): Answer['steps'][number] => {
  const hit = answer.steps.find((s) => s.id === id)
  if (hit === undefined) throw new Error(`no step ${id}`)
  return hit
}

const healthy = (overrides: HubAnswers = {}, failing: readonly string[] = []): McpContext =>
  fakeHub({ ...HEALTHY, ...overrides }, { failing }).ctx

describe('setup_wizard: the steps are the manifest', () => {
  it('answers the steps of the docs, in their order, with their pages', async () => {
    const answer = await wizard(noHub())

    expect(answer.steps.map((s) => s.id)).toEqual(MANIFEST.steps.map((s) => s.id))
    expect(answer.manifest).toMatchObject({
      source: 'bundled',
      revision: MANIFEST.revision,
    })
  })

  it('every step of the bundled manifest has an evaluator, and no evaluator is orphaned', () => {
    expect(Object.keys(STEP_EVALUATORS).toSorted()).toEqual(
      MANIFEST.steps.map((s) => s.id).toSorted(),
    )
  })

  it('a step the docs added after this CLI was built is unknown with an update hint, never missing', async () => {
    const first = MANIFEST.steps[0]
    if (first === undefined) throw new Error('empty manifest')
    const newer: ManifestProvider = async () => ({
      manifest: {
        ...MANIFEST,
        steps: [{ ...first, id: 'brand-new' }, ...MANIFEST.steps],
      },
      source: 'live',
      note: null,
    })

    const answer = await wizard(noHub({ manifest: newer }))

    expect(step(answer, 'brand-new').status).toBe('unknown')
    expect(step(answer, 'brand-new').reason).toMatch(/update/)
    expect(answer.nextStep?.id).toBe('feasibility')
  })

  it('says so when the steps come from the bundled copy because the docs site did not answer', async () => {
    const offline: ManifestProvider = async () => ({
      manifest: MANIFEST,
      source: 'bundled',
      note: 'the docs site did not answer (timeout)',
    })

    const answer = await wizard(noHub({ manifest: offline }))

    expect(answer.notices.join(' ')).toContain('did not answer')
  })
})

describe('setup_wizard: before a hub exists', () => {
  it('nothing installed, nothing checked: the next step is feasibility, starting from the host check', async () => {
    const answer = await wizard(noHub())

    expect(answer.state).toMatchObject({
      phase: 'before-install',
      hub: null,
      verdict: null,
    })
    expect(answer.nextStep).toMatchObject({
      id: 'feasibility',
      startWith: 'host-check',
    })
    expect(answer.nextStep?.actions.map((a) => a.tool)).toContain('setup_feasibility')
    expect(answer.nextStep?.page).toBe('https://docs.dominevo.app/docs/get-started#feasibility')
  })

  it('what needs a hub is unknown with the reason, not missing', async () => {
    const answer = await wizard(noHub())

    for (const id of ['storage', 'cameras', 'backups']) {
      expect(step(answer, id).status, id).toBe('unknown')
      expect(answer.unavailable[id], id).toContain('no usable hub session')
    }
  })

  it('once the machine was checked the next step is the install, and the verdict is provisional', async () => {
    const answer = await wizard(
      noHub({ onboardingState: memoryStateStore({ feasibility: REMEMBERED }) }),
    )

    expect(step(answer, 'feasibility').status).toBe('done')
    expect(answer.nextStep).toMatchObject({
      id: 'install',
      startWith: 'install-guide',
    })
    expect(answer.state.verdict).toMatchObject({
      kind: 'provisional',
      answer: 'hub-plus-agents',
    })
    expect(answer.notices.join(' ')).toMatch(/estimate/)
  })

  it('a hub that is configured but does not answer is the install step with the reason, not a crash', async () => {
    const answer = await wizard(
      noHub({
        hub: async () => {
          throw new Error('self-signed certificate')
        },
      }),
    )

    expect(answer.nextStep?.id).toBe('feasibility')
    expect(step(answer, 'install').detail).toContain('self-signed certificate')
  })
})

describe('setup_wizard: against a hub', () => {
  it('a session that is not an administrator stops at the first sign-in', async () => {
    const { ctx } = fakeHub(HEALTHY, { tier: 'protected' })

    const answer = await wizard(ctx)

    expect(answer.nextStep).toMatchObject({
      id: 'first-login',
      startWith: 'sign-in',
    })
    expect(step(answer, 'backups').status).toBe('unknown')
  })

  it('a hub with everything set up has nothing left', async () => {
    const answer = await wizard(healthy())

    expect(answer.steps.filter((s) => !['done', 'not-needed'].includes(s.status))).toEqual([])
    expect(answer.nextStep).toBeNull()
    expect(answer.state.phase).toBe('complete')
  })

  it.each([
    ['first-login', 'userManagement.listUsers'],
    ['first-login', 'userManagement.getAdminBootstrapStatus'],
    ['agents', 'nodes.topology'],
    ['storage', 'storage.listLocations'],
    ['core-addons', 'addons.list'],
    ['cameras', 'deviceManager.listAll'],
    ['detection', 'pipelineOrchestrator.getNodeCapacityVerdict'],
    ['notifications', 'notificationRules.listRules'],
    ['backups', 'backup.listDestinations'],
    ['keep-current', 'addons.listUpdates'],
  ])('%s: a read that failed is unknown with its reason, never missing', async (id, path) => {
    const answer = await wizard(healthy({}, [path]))

    expect(step(answer, id).status).toBe('unknown')
    expect(answer.unavailable[id]).toContain('exploded')
  })

  it('an admin that still has the default password is missing, even with 2FA', async () => {
    const answer = await wizard(
      healthy({
        'userManagement.getAdminBootstrapStatus': {
          defaultPasswordInUse: true,
        },
      }),
    )

    expect(answer.nextStep).toMatchObject({
      id: 'first-login',
      startWith: 'secure-admin',
    })
    const secure = answer.nextStep?.actions.find((a) => a.id === 'secure-admin')
    expect(secure?.tool).toBeUndefined()
    expect(secure?.manual?.ui?.route).toBe('/system/identity')
  })

  it('no recordings location is missing; only the default one is suggested', async () => {
    const none = await wizard(healthy({ 'storage.listLocations': [location('logs:default')] }))
    expect(none.nextStep).toMatchObject({
      id: 'storage',
      startWith: 'add-location',
    })

    const system = await wizard(
      healthy({
        'storage.listLocations': [location('recordings:default', { isSystem: true })],
      }),
    )
    expect(step(system, 'storage').status).toBe('suggested')
  })

  it('a hub with no camera integration set up stops at core addons with the exact next action', async () => {
    const answer = await wizard(
      healthy({
        'addons.list': SEEDED.map((a) => ({
          manifest: { id: a.id, packageName: a.package, packageVersion: '1' },
        })),
      }),
    )

    expect(answer.nextStep?.id).toBe('core-addons')
    expect(step(answer, 'core-addons').detail).toContain('@dominevo/addon-provider-onvif')
  })

  it('a hub reachable on the LAN only: remote access is suggested, not missing', async () => {
    const lan: HubAnswers = {
      'localNetwork.getAddresses': { roles: {} },
      'networkAccess.getStatus': { connected: false, endpoint: null },
    }

    const unasked = await wizard(healthy(lan))
    expect(step(unasked, 'remote-access').status).toBe('suggested')

    const atHome = await wizard(healthy(lan), { remoteAccess: false })
    expect(step(atHome, 'remote-access').status).toBe('not-needed')

    const away = await wizard(healthy(lan), { remoteAccess: true })
    expect(step(away, 'remote-access').status).toBe('missing')
  })

  it('lists the cameras no detection rule covers', async () => {
    const answer = await wizard(
      healthy({
        'deviceManager.listAll': [
          { id: 7, name: 'Door' },
          { id: 8, name: 'Yard' },
        ],
      }),
    )

    expect(step(answer, 'notifications').status).toBe('missing')
    expect(step(answer, 'notifications').detail).toContain('Yard (8)')
  })
})

describe('setup_wizard: onboarding audit fixes', () => {
  const capacity = { totalBytes: 2_000_000_000_000, availableBytes: 1_000_000_000_000 }

  it('storage: recordings on the same volume as the data default are not a dedicated disk', async () => {
    const shared = await wizard(
      healthy({
        'storage.listLocations': [
          location('data:default', { capacity }),
          location('recordings:disk2', { capacity }),
        ],
      }),
    )
    expect(step(shared, 'storage').status).toBe('suggested')

    const dedicated = await wizard(
      healthy({
        'storage.listLocations': [
          location('data:default', { capacity }),
          location('recordings:disk2', {
            capacity: { totalBytes: 8_000_000_000_000, availableBytes: 7_000_000_000_000 },
          }),
        ],
      }),
    )
    expect(step(dedicated, 'storage').status).toBe('done')
  })

  it('cameras: recording off and a missing sub stream are not done, and the cameras are named', async () => {
    const answer = await wizard(
      healthy({
        'deviceManager.listAll': [
          { id: 7, name: 'Door' },
          { id: 8, name: 'Yard' },
        ],
        'recordingArchive.getDeviceConfig': (input: unknown) => {
          const { deviceId } = z.object({ deviceId: z.number() }).parse(input)
          return deviceId === 8 ? { enabled: false, bands: [] } : EVENTS_EVERY_DAY
        },
        'streamBroker.listAllCameraStreams': [
          nativeStream(7, 'main', 2560),
          nativeStream(7, 'sub', 640),
          nativeStream(8, 'main', 2560),
          nativeStream(8, 'sub', 640),
        ],
        'streamBroker.listAllProfileSlots': [
          slot(7, 'high', 'main'),
          slot(7, 'low', 'sub'),
          slot(8, 'high', 'main'),
        ],
      }),
    )

    const cameras = step(answer, 'cameras')
    expect(cameras.status).toBe('missing')
    expect(cameras.detail).toContain('Yard (8)')
    expect(cameras.detail).toContain('recording off')
    expect(cameras.detail).toContain('sub')
    expect(cameras.detail).not.toContain('Door')
  })

  it('cameras: a recording config that could not be read is unknown, not missing', async () => {
    const answer = await wizard(healthy({}, ['recordingArchive.getDeviceConfig']))
    expect(step(answer, 'cameras').status).toBe('unknown')
  })

  it.each([
    ['a LAN address', 'https://192.168.1.50:3443'],
    ['a loopback address', 'https://localhost:3443'],
    ['the plain-http LAN port', 'http://hub.example.test:3000'],
    ['a .local name', 'https://camstack.local'],
  ])('remote access: %s is not a public endpoint', async (_name, resolved) => {
    const answer = await wizard(
      healthy({
        'localNetwork.getAddresses': { roles: { publicEndpoint: { resolved } } },
        'networkAccess.getStatus': { connected: false, endpoint: { stable: true } },
      }),
    )
    expect(step(answer, 'remote-access').status).toBe('suggested')
  })

  it('remote access and the core addons remote group read one public-endpoint judgement', async () => {
    const remoteGroup = async (resolved: string): Promise<string | undefined> => {
      const hub = healthy({
        'localNetwork.getAddresses': { roles: { publicEndpoint: { resolved } } },
        'networkAccess.getStatus': { connected: false, endpoint: null },
        'addons.list': SEEDED.map((a) => ({
          manifest: { id: a.id, packageName: a.package, packageVersion: '1' },
        })),
      })
      const out = await setupCoreAddons(hub, { remoteAccess: true })
      if (out.status !== 'ok') throw new Error(out.status)
      return out.groups.find((g) => g.id === 'remote-access')?.status
    }
    expect(await remoteGroup('http://10.0.0.5:3000')).toBe('suggested')
    expect(await remoteGroup('https://hub.example.test')).toBe('configured')
  })

  it('install: a hub that is configured but does not answer is not a reason to reinstall', async () => {
    const ctx = noHub({
      hub: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    const answer = await wizard(ctx)
    expect(step(answer, 'install').detail).toContain('did not answer')
    expect(step(answer, 'install').detail).not.toContain('Not installed yet')
  })

  it('add-target names configure_notifiers', async () => {
    const answer = await wizard(healthy({ 'notificationRules.listRules': { rules: [] } }), {
      step: 'notifications',
    })
    const add = answer.requestedStep?.actions.find((a) => a.id === 'add-target')
    expect(add?.note).toContain('configure_notifiers')
  })
})

describe('setup_wizard: the capacity verdict', () => {
  const alone: HubAnswers = {
    'nodes.topology': [{ id: 'hub', isHub: true, isOnline: true }],
    'deviceManager.listAll': [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      name: `cam${id}`,
    })),
    'notificationRules.listRules': {
      rules: [
        {
          enabled: true,
          delivery: 'system-event',
          conditions: { systemEvent: { kinds: ['node-offline'] } },
        },
        { enabled: true, delivery: 'immediate', conditions: {} },
      ],
    },
  }

  it('measured replaces provisional: the limit is the smaller plane and it is named', async () => {
    const { ctx } = fakeHub(
      {
        ...HEALTHY,
        ...alone,
        'pipelineOrchestrator.getNodeCapacityVerdict': [node('hub', 4, 9)],
      },
      {
        extra: {
          onboardingState: memoryStateStore({ feasibility: REMEMBERED }),
        },
      },
    )

    const answer = await wizard(ctx)

    expect(answer.state.verdict).toEqual({
      kind: 'measured',
      hubCapacity: 4,
      limitedBy: 'decode',
      cameras: 6,
      answer: 'hub-plus-agents',
    })
    expect(step(answer, 'agents').status).toBe('missing')
    expect(step(answer, 'agents').detail).toMatch(/limited by decode/)
    expect(answer.nextStep?.id).toBe('agents')
  })

  it('a hub measured above its cameras needs no agent, whatever the estimate said', async () => {
    const { ctx } = fakeHub(
      {
        ...HEALTHY,
        ...alone,
        'pipelineOrchestrator.getNodeCapacityVerdict': [node('hub', 12, 9)],
      },
      {
        extra: {
          onboardingState: memoryStateStore({ feasibility: REMEMBERED }),
        },
      },
    )

    const answer = await wizard(ctx)

    expect(answer.state.verdict).toMatchObject({
      kind: 'measured',
      answer: 'hub-only',
      limitedBy: 'detection',
    })
    expect(step(answer, 'agents').status).toBe('not-needed')
  })

  it('a benchmark that measured only one plane is not a verdict: the step is missing and the estimate stands', async () => {
    const half = {
      ...node('hub', 4, 9),
      decode: null,
      capacity: null,
      limitedBy: null,
      complete: false,
    }
    const { ctx } = fakeHub(
      {
        ...HEALTHY,
        ...alone,
        'pipelineOrchestrator.getNodeCapacityVerdict': [half],
      },
      {
        extra: {
          onboardingState: memoryStateStore({ feasibility: REMEMBERED }),
        },
      },
    )

    const answer = await wizard(ctx)

    expect(answer.state.verdict?.kind).toBe('provisional')
    expect(answer.nextStep).toMatchObject({
      id: 'detection',
      startWith: 'read-benchmark',
    })
    expect(step(answer, 'agents').status).toBe('suggested')
  })

  it('a hub too old to report a measured capacity leaves the verdict provisional and says why', async () => {
    const { ctx } = fakeHub(
      { ...HEALTHY, ...alone },
      {
        failing: ['pipelineOrchestrator.getNodeCapacityVerdict'],
        extra: {
          onboardingState: memoryStateStore({ feasibility: REMEMBERED }),
        },
      },
    )

    const answer = await wizard(ctx)

    expect(answer.state.verdict?.kind).toBe('provisional')
    expect(step(answer, 'detection').status).toBe('unknown')
  })
})

describe('setup_wizard: hardware outside the measured tables', () => {
  const unmeasured: RememberedFeasibility = {
    ...REMEMBERED,
    measured: false,
    hardwareClass: 'unknown',
    cpuModel: UNMEASURED_CPU,
  }

  it('offers the report link, and puts the benchmark in it once it ran — with no node id', async () => {
    const { ctx } = fakeHub(
      {
        ...HEALTHY,
        'pipelineOrchestrator.getNodeCapacityVerdict': [node('hub-secret-name', 6, 9)],
      },
      {
        extra: {
          onboardingState: memoryStateStore({ feasibility: unmeasured }),
          host: fakeHost(linuxHost(UNMEASURED_CPU, true)),
        },
      },
    )

    const answer = await wizard(ctx)

    const url = new URL(answer.hardwareReport?.url ?? '')
    expect(url.searchParams.get('host-check')).toContain('i5-8500')
    expect(url.searchParams.get('benchmark')).toContain('decodes 6 stream(s) at 3840x2160@15 h265')
    expect(url.toString()).not.toContain('hub-secret-name')
    expect(url.toString()).not.toContain('hub.example.test')
    expect(answer.notices.join(' ')).toMatch(/submit it themselves/)
  })

  it('measured hardware gets no link', async () => {
    const { ctx } = fakeHub(HEALTHY, {
      extra: { onboardingState: memoryStateStore({ feasibility: REMEMBERED }) },
    })
    expect((await wizard(ctx)).hardwareReport).toBeNull()
  })
})

describe('setup_wizard: actions', () => {
  it('step returns that step whatever its status; an id that is not a step is said', async () => {
    const answer = await wizard(healthy(), { step: 'storage' })
    expect(answer.requestedStep?.id).toBe('storage')
    expect(answer.requestedStep?.actions.map((a) => a.tool)).toContain(
      'configure_setup_location_create',
    )

    const wrong = await wizard(healthy(), { step: 'nope' })
    expect(wrong.requestedStep).toBeUndefined()
    expect(wrong.notices.join(' ')).toContain("'nope' is not a step")
  })

  it('an action whose tool this server does not serve falls back to the manual rendering', async () => {
    const server = createPublicServer({
      toolsets: ['setup'],
      context: healthy(),
      versionPreflight: false,
    })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(b)

    const answer = Answer.parse(await callJson(client, 'setup_wizard', { step: 'storage' }))

    const create = answer.requestedStep?.actions.find((x) => x.id === 'add-location')
    expect(create?.tool).toBeUndefined()
    expect(create?.note).toContain('not served')
    expect(create?.manual?.ui?.route).toBe('/system/data?tab=storage')
  })

  it('every tool an answer names is a tool this server lists', async () => {
    const client = await connectPublic(healthy())
    const listed = new Set((await client.listTools()).tools.map((t) => t.name))
    for (const s of MANIFEST.steps) {
      const answer = Answer.parse(await callJson(client, 'setup_wizard', { step: s.id }))
      for (const action of answer.requestedStep?.actions ?? []) {
        if (action.tool !== undefined) expect(listed, `${s.id}/${action.id}`).toContain(action.tool)
      }
    }
  })

  it('only reads, never touches a secret-bearing path, and leaks no token or config', async () => {
    const { ctx, calls } = fakeHub(HEALTHY)
    const client = await connectPublic(ctx)
    const raw = JSON.stringify(await callJson(client, 'setup_wizard'))

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls.filter((c) => isSecretBearing(c.path))).toEqual([])
    for (const leak of [
      'tok-should-never-appear',
      'SECRET-HASH',
      'SECRET-TARGET-TOKEN',
      'passwordHash',
      '"config"',
    ]) {
      expect(raw).not.toContain(leak)
    }
  })
})

describe('what an assistant is told first', () => {
  it('the server instructions and the get-started prompt both start from setup_wizard', async () => {
    const client = await connectPublic(noHub())

    expect(client.getInstructions()).toContain('setup_wizard')
    const prompt = await client.getPrompt({ name: 'get-started' })
    const text = JSON.stringify(prompt.messages)
    expect(text).toContain('setup_wizard')
    for (const s of MANIFEST.steps) expect(text).toContain(s.title)
  })
})
