/**
 * D651 fix rounds, at the wiring: a pass that REWRITES an index (the face
 * re-embed, automatic or the operator's, and the CLIP rebuild) pins only the
 * OWNER's answer (`pipelineOrchestrator.getClusterModelChoice`), read twice
 * and agreeing. The hydrated settings view in this harness ALWAYS answers the
 * defaults: a pin that trusted it would start a pass in every refusal below.
 *
 * Every refusal is asserted on its OWN evidence — the confirmer's refusal
 * line, with its reason — and on the absence of `auto re-embed failed`. A
 * "no pass" that came from an unrelated throw caught by the timer's `catch`
 * would otherwise read as the gate working.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AddonApi,
  type AddonContext,
  type ClusterModelChoice,
  type IScopedLogger,
  clusterModelSettingKey,
} from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import {
  makeFakeAddonApi,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makePipelineBootRecords,
} from './test-helpers.js'

/** One scripted owner answer; `throw` = a failed call. */
type OwnerAnswer = ClusterModelChoice | 'throw'

const stored = (modelId: string): OwnerAnswer => ({ kind: 'stored', modelId })
const ABSENT: OwnerAnswer = { kind: 'absent', defaultModelId: 'auraface-r100' }
const NOT_READY: OwnerAnswer = { kind: 'unreadable', reason: 'owner-not-ready' }
const INVALID: OwnerAnswer = { kind: 'unreadable', reason: 'invalid-stored' }
/** The HYDRATED view a defaults-only store produces — what the first read trusted. */
const hydratedDefaults = {
  sections: [
    { fields: [{ key: clusterModelSettingKey('face-embedding'), value: 'auraface-r100' }] },
  ],
}

interface LogLine {
  readonly message: string
  readonly meta?: Record<string, unknown>
}
const infoLines: LogLine[] = []
const warnLines: LogLine[] = []

function capturingLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => {
      infoLines.push({ message, ...(extras?.meta ? { meta: extras.meta } : {}) })
    },
    warn: (message: string, extras?: { meta?: Record<string, unknown> }) => {
      warnLines.push({ message, ...(extras?.meta ? { meta: extras.meta } : {}) })
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface ReembedSeam {
  maybeAutoReembedFaces(): Promise<void>
  getFaceReembedStatus(): Promise<{
    modelId: string
    inSpace: number
    total: number
    modelUnreadable?: string
    modelByAbsence?: boolean
  }>
  runFaceReembedPass(input: { maxSamples?: number }, target?: string): Promise<unknown>
  rebuildObjectEmbeddings(input: Record<string, never>): Promise<{
    started: boolean
    alreadyRunning: boolean
    refusal?: string
    modelId?: string
  }>
  identityStore: {
    createIdentity(input: { name: string }): Promise<{ id: string }>
    addSample(input: {
      identityId: string
      embedding: readonly number[]
      modelId: string
      source: 'detected'
      mediaId: number
    }): Promise<unknown>
  } | null
}

interface Booted {
  readonly seam: ReembedSeam
  /** How many times the owner was asked. */
  readonly ownerCalls: () => number
}

interface BootOptions {
  /** The model the one enrolled sample carries. Default: ArcFace (work to do). */
  readonly sampleModelId?: string
  /** Boot against an orchestrator that predates the method. */
  readonly withoutMethod?: boolean
}

let addon: PipelineAnalyticsAddon | null = null
afterEach(async () => {
  await addon?.shutdown()
  addon = null
})

async function boot(answers: readonly OwnerAnswer[], options: BootOptions = {}): Promise<Booted> {
  infoLines.length = 0
  warnLines.length = 0
  const settings = makeFakeSettingsStore()
  const queue = [...answers]
  let calls = 0
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: makeFakeDeviceManager().api.deviceManager,
  })
  const getClusterModelChoice = {
    query: async (): Promise<ClusterModelChoice> => {
      calls += 1
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next === undefined || next === 'throw') throw new Error('UDS timeout')
      return next
    },
  }
  const withOrchestrator: AddonApi = {
    ...api,
    addonSettings: { getGlobalSettings: { query: async () => hydratedDefaults } },
    pipelineOrchestrator: options.withoutMethod ? {} : { getClusterModelChoice },
  } as unknown as AddonApi
  const records = await makePipelineBootRecords()
  const ctx = {
    id: 'pipeline-analytics',
    logger: capturingLogger(),
    records,
    eventBus: makeFakeEventBus().bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage: makeFakeStorageProvider(),
      devices: { getAll: async () => [], getChildren: async () => [] },
    },
    api: withOrchestrator,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => undefined,
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
      getSection: async () => ({}),
      setSection: async () => undefined,
    },
    getNativeProvider: () => {
      throw new Error('no native providers in this spec')
    },
    fetchDevice: async () => {
      throw new Error('no devices in this spec')
    },
  } as unknown as AddonContext
  addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  const seam = addon as unknown as ReembedSeam
  const store = seam.identityStore
  if (store === null) throw new Error('identity store not built')
  const who = await store.createIdentity({ name: 'Carol' })
  await store.addSample({
    identityId: who.id,
    embedding: [0.5, 0.75],
    modelId: options.sampleModelId ?? 'arcface-r100',
    source: 'detected',
    mediaId: 1,
  })
  // Boot itself may ask; count only what the test drives.
  calls = 0
  return { seam, ownerCalls: () => calls }
}

/** The confirmer's own refusal line for `caller`, with its reason. */
function refusalsOf(caller: string): readonly LogLine[] {
  return infoLines.filter(
    (l) => l.message.startsWith(`${caller}:`) && /NOT confirmed/.test(l.message),
  )
}

/** The timer's catch-all line: its presence means a "no pass" is vacuous. */
function autoFailures(): readonly LogLine[] {
  return warnLines.filter((l) => /auto re-embed failed/.test(l.message))
}

describe('the automatic face re-embed pins only a twice-read OWNER answer', () => {
  it.each([
    ['owner not ready (hydrated view says defaults)', [NOT_READY], 'owner-not-ready'],
    ['a failed call', ['throw'], 'read-failed'],
    ['an invalid stored value', [INVALID], 'invalid-stored'],
  ] as const)('%s starts no pass, and says why', async (_label, answers, reason) => {
    const { seam } = await boot(answers)
    const pass = vi.spyOn(seam, 'runFaceReembedPass').mockResolvedValue({})
    await seam.maybeAutoReembedFaces()
    expect(pass).not.toHaveBeenCalled()
    expect(autoFailures()).toEqual([])
    expect(refusalsOf('face-reembed-auto').map((l) => l.meta?.['reason'])).toEqual([reason])
  })

  it('an orchestrator WITHOUT the method (rolling release) starts no pass: method-unavailable', async () => {
    const { seam } = await boot([], { withoutMethod: true })
    const pass = vi.spyOn(seam, 'runFaceReembedPass').mockResolvedValue({})
    await seam.maybeAutoReembedFaces()
    expect(pass).not.toHaveBeenCalled()
    expect(autoFailures()).toEqual([])
    expect(refusalsOf('face-reembed-auto').map((l) => l.meta?.['reason'])).toEqual([
      'method-unavailable',
    ])
  })

  it('a second read that disagrees with the first starts no pass', async () => {
    const { seam } = await boot([stored('auraface-r100'), stored('inception-resnet-v1')])
    const pass = vi.spyOn(seam, 'runFaceReembedPass').mockResolvedValue({})
    await seam.maybeAutoReembedFaces()
    expect(pass).not.toHaveBeenCalled()
    expect(autoFailures()).toEqual([])
    expect(refusalsOf('face-reembed-auto').map((l) => l.meta?.['reason'])).toEqual([
      'reads-disagree',
    ])
  })

  it('a stored choice read twice, agreeing, starts ONE bounded pass pinned to it', async () => {
    const { seam, ownerCalls } = await boot([stored('auraface-r100'), stored('auraface-r100')])
    const pass = vi.spyOn(seam, 'runFaceReembedPass').mockResolvedValue({})
    await seam.maybeAutoReembedFaces()
    expect(pass).toHaveBeenCalledTimes(1)
    expect(pass).toHaveBeenCalledWith({ maxSamples: 200 }, 'auraface-r100')
    expect(ownerCalls()).toBe(2)
  })

  it('an install that never stored a choice follows the default BY ABSENCE', async () => {
    const { seam } = await boot([ABSENT, ABSENT])
    const pass = vi.spyOn(seam, 'runFaceReembedPass').mockResolvedValue({})
    await seam.maybeAutoReembedFaces()
    expect(pass).toHaveBeenCalledWith({ maxSamples: 200 }, 'auraface-r100')
  })

  it('the steady state — nothing outside the space — asks the owner ONCE', async () => {
    const { seam, ownerCalls } = await boot([stored('auraface-r100')], {
      sampleModelId: 'auraface-r100',
    })
    const pass = vi.spyOn(seam, 'runFaceReembedPass').mockResolvedValue({})
    await seam.maybeAutoReembedFaces()
    expect(pass).not.toHaveBeenCalled()
    expect(ownerCalls()).toBe(1)
  })

  it('the operator path refuses by name and changes nothing', async () => {
    const { seam } = await boot([NOT_READY])
    await expect(seam.runFaceReembedPass({})).rejects.toThrow(/not confirmed \(owner-not-ready\)/)
  })
})

describe('the re-embed status reads the SAME owner answer the pass pins on', () => {
  it('counts against the stored choice', async () => {
    const { seam } = await boot([stored('arcface-r100')])
    expect(await seam.getFaceReembedStatus()).toMatchObject({
      modelId: 'arcface-r100',
      inSpace: 1,
      total: 1,
    })
  })

  it('names an unreadable owner instead of counting against a guessed default', async () => {
    const { seam } = await boot([NOT_READY], { sampleModelId: 'auraface-r100' })
    const status = await seam.getFaceReembedStatus()
    expect(status).toMatchObject({ modelId: '', inSpace: 0, modelUnreadable: 'owner-not-ready' })
  })

  it('says when the model is the default by absence', async () => {
    const { seam } = await boot([ABSENT], { sampleModelId: 'auraface-r100' })
    expect(await seam.getFaceReembedStatus()).toMatchObject({
      modelId: 'auraface-r100',
      inSpace: 1,
      modelByAbsence: true,
    })
  })
})

describe('each caller logs its own state changes', () => {
  it('the operator path says it was refused even after the auto path already said so', async () => {
    const { seam } = await boot([NOT_READY])
    vi.spyOn(seam, 'runFaceReembedPass')
    await seam.maybeAutoReembedFaces()
    await seam.maybeAutoReembedFaces()
    expect(refusalsOf('face-reembed-auto')).toHaveLength(1)
    vi.restoreAllMocks()
    await expect(seam.runFaceReembedPass({})).rejects.toThrow(/owner-not-ready/)
    expect(refusalsOf('face-reembed-operator')).toHaveLength(1)
  })
})

/**
 * The CLIP rebuild overwrites every track's vector with the model it pins, so
 * its model choice takes the same owner answer, twice-read.
 */
describe('the CLIP rebuild pins only a twice-read OWNER answer', () => {
  it('refuses by name when the owner is not ready — hydrated defaults are not a choice', async () => {
    const { seam } = await boot([NOT_READY])
    expect(await seam.rebuildObjectEmbeddings({})).toEqual({
      started: false,
      alreadyRunning: false,
      refusal: 'owner-not-ready',
    })
  })

  it('refuses by name against an orchestrator without the method', async () => {
    const { seam } = await boot([], { withoutMethod: true })
    expect(await seam.rebuildObjectEmbeddings({})).toEqual({
      started: false,
      alreadyRunning: false,
      refusal: 'method-unavailable',
    })
  })

  it('refuses by name when the two reads disagree', async () => {
    const { seam } = await boot([stored('mobileclip-s1'), stored('mobileclip-s2')])
    expect(await seam.rebuildObjectEmbeddings({})).toEqual({
      started: false,
      alreadyRunning: false,
      refusal: 'reads-disagree',
    })
  })

  it('a CONFIRMED model with no CLIP contract is refused in the same field and vocabulary (D649)', async () => {
    const { seam } = await boot([stored('mobileclip-s0'), stored('mobileclip-s0')])
    expect(await seam.rebuildObjectEmbeddings({})).toEqual({
      started: false,
      alreadyRunning: false,
      refusal: 'not-a-clip-model',
      modelId: 'mobileclip-s0',
    })
  })
})
