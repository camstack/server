/**
 * A fake `training-provider`: an in-memory cloud with controllable
 * transitions. The engine's specs and the provider contract suite run
 * against it; nothing here talks to a network.
 *
 * Behaves like the contract demands of every provider: a retried submit with
 * the same jobKey never starts a second job, cancel and cleanup are
 * idempotent, an unknown jobKey is `lost`, and the dataset arrives through a
 * peer-bytes ticket that is taken exactly once.
 */
import type {
  ITrainingCloudProvider,
  ProviderJobState,
  ProviderJobStatus,
  TrainingCredentialCheck,
  TrainingLogLine,
  TrainingProviderDescriptor,
  TrainingProviderEntry,
  TrainingProviderType,
} from '@camstack/types'
import type { MemoryPeerBytes } from './memory-peer-bytes.js'

export const FAKE_TYPE_ID = 'fake'
export const FAKE_ICON_ASSET = 'assets/training/icon.svg'
export const FAKE_DEFAULT_ENTRY_ID = 'fake-default'

export interface FakeCloudJob {
  readonly jobKey: string
  readonly entryId: string
  state: ProviderJobState
  submits: number
  startedAt: number | null
  endedAt: number | null
  exitCode: number | null
  costUsd: number
  jobSpecJson: string | null
  dataset: { bytes: number; sha256: string } | null
  datasetDeleted: boolean
  logs: TrainingLogLine[]
  resultText: string | null
  bundle: Buffer | null
}

export interface FakeEntrySeed {
  readonly entryId: string
  name: string
  configured: boolean
}

export interface FakeProviderOptions {
  readonly addonId?: string
  readonly configured?: boolean
  readonly costCapUsd?: number
  readonly failedDatasetGraceHours?: number
  readonly entries?: readonly FakeEntrySeed[]
  readonly peer: MemoryPeerBytes
  readonly now: () => number
}

export class FakeTrainingProvider implements ITrainingCloudProvider {
  readonly addonId: string
  readonly defaultEntryId: string
  readonly jobs = new Map<string, FakeCloudJob>()
  readonly calls: string[] = []
  private entries: FakeEntrySeed[]
  private readonly options: FakeProviderOptions

  constructor(options: FakeProviderOptions) {
    this.options = options
    this.addonId = options.addonId ?? 'training-fake'
    this.defaultEntryId = FAKE_DEFAULT_ENTRY_ID
    this.entries = options.entries
      ? [...options.entries]
      : [
          {
            entryId: FAKE_DEFAULT_ENTRY_ID,
            name: 'Default',
            configured: options.configured ?? true,
          },
        ]
  }

  // ── Controls (tests) ───────────────────────────────────────────────

  advance(jobKey: string, state: ProviderJobState, exitCode?: number): void {
    const job = this.require(jobKey)
    job.state = state
    if (state === 'running' && job.startedAt === null) job.startedAt = this.options.now()
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      job.endedAt = this.options.now()
      job.exitCode = exitCode ?? (state === 'succeeded' ? 0 : 1)
    }
  }

  emit(jobKey: string, ...texts: string[]): void {
    const job = this.require(jobKey)
    for (const text of texts) job.logs.push({ ts: this.options.now(), text })
  }

  setCost(jobKey: string, usd: number): void {
    this.require(jobKey).costUsd = usd
  }

  finish(
    jobKey: string,
    outcome: { readonly resultText: string; readonly bundle: Buffer | null },
  ): void {
    const job = this.require(jobKey)
    job.resultText = outcome.resultText
    job.bundle = outcome.bundle
  }

  /** The provider forgets the job (account reset, retention). */
  forget(jobKey: string): void {
    this.jobs.delete(jobKey)
  }

  /** A job started outside our records (a crashed hub, a second hub on the account). */
  plantOrphan(jobKey: string): void {
    this.jobs.set(jobKey, this.blank(jobKey, this.defaultEntryId, 'running'))
  }

  // ── The capability ─────────────────────────────────────────────────

  readonly describe = async (): Promise<readonly TrainingProviderDescriptor[]> =>
    this.entries.map((entry) => this.descriptorOf(entry))

  readonly describeTypes = async (): Promise<readonly TrainingProviderType[]> => [
    {
      typeId: FAKE_TYPE_ID,
      label: 'Fake cloud',
      iconAsset: FAKE_ICON_ASSET,
      addonId: this.addonId,
    },
  ]

  readonly listEntries = async (): Promise<readonly TrainingProviderEntry[]> =>
    this.entries.map((entry) => ({
      entryId: entry.entryId,
      typeId: FAKE_TYPE_ID,
      name: entry.name,
      addonId: this.addonId,
      configured: entry.configured,
    }))

  readonly createEntry = async (input: { typeId: string; name: string }) => {
    if (input.typeId !== FAKE_TYPE_ID) throw new Error(`unknown type "${input.typeId}"`)
    const entryId = `fake-${String(this.entries.length + 1)}`
    this.entries.push({ entryId, name: input.name, configured: false })
    return { entryId }
  }

  readonly updateEntry = async (input: { entryId: string; name: string }) => {
    const entry = this.entries.find((e) => e.entryId === input.entryId)
    if (entry === undefined) throw new Error(`unknown entry "${input.entryId}"`)
    entry.name = input.name
    entry.configured = true
    return { ok: true as const }
  }

  readonly deleteEntry = async (input: { entryId: string }) => {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.entryId !== input.entryId)
    if (this.entries.length === before) throw new Error(`unknown entry "${input.entryId}"`)
    return { ok: true as const }
  }

  readonly validateCredentials = async (input: {
    entryId: string
  }): Promise<TrainingCredentialCheck> => {
    const entry = this.entries.find((e) => e.entryId === input.entryId)
    if (entry === undefined) return { ok: false, reason: 'missing', detail: 'unknown entry' }
    return entry.configured
      ? { ok: true, account: 'fake-workspace' }
      : { ok: false, reason: 'missing' }
  }

  readonly estimateJob = async (input: { gpuSecondsLow: number; gpuSecondsHigh: number }) => ({
    usdLow: (input.gpuSecondsLow / 3600) * 0.8,
    usdHigh: (input.gpuSecondsHigh / 3600) * 0.8,
    notes: [],
  })

  readonly uploadDataset = async (input: {
    entryId: string
    jobKey: string
    ticket: Parameters<MemoryPeerBytes['take']>[0]
  }) => {
    this.requireEntry(input.entryId)
    this.calls.push(`upload:${input.jobKey}`)
    const taken = await this.options.peer.take(input.ticket)
    const job = this.jobs.get(input.jobKey) ?? this.blank(input.jobKey, input.entryId, 'pending')
    job.dataset = { bytes: taken.bytes.length, sha256: taken.sha256 }
    job.datasetDeleted = false
    this.jobs.set(input.jobKey, job)
    return { bytes: taken.bytes.length, sha256: taken.sha256 }
  }

  readonly submitJob = async (input: {
    entryId: string
    jobKey: string
    jobSpecJson: string
    gpuType: string
  }) => {
    this.requireEntry(input.entryId)
    this.calls.push(`submit:${input.jobKey}`)
    const job = this.jobs.get(input.jobKey) ?? this.blank(input.jobKey, input.entryId, 'pending')
    job.submits += 1
    if (job.jobSpecJson === null) job.jobSpecJson = input.jobSpecJson
    this.jobs.set(input.jobKey, job)
    return this.status(job)
  }

  readonly getJob = async (input: { jobKey: string }): Promise<ProviderJobStatus> => {
    const job = this.jobs.get(input.jobKey)
    return job === undefined ? this.lostStatus(input.jobKey) : this.status(job)
  }

  readonly listJobEvents = async (input: { jobKey: string; cursor?: string; max: number }) => {
    const job = this.jobs.get(input.jobKey)
    const from = input.cursor === undefined ? 0 : Number(input.cursor)
    const lines = job === undefined ? [] : job.logs.slice(from, from + input.max)
    return { lines, cursor: String(from + lines.length) }
  }

  readonly cancelJob = async (input: { jobKey: string }) => {
    this.calls.push(`cancel:${input.jobKey}`)
    const job = this.jobs.get(input.jobKey)
    if (
      job !== undefined &&
      (job.state === 'pending' || job.state === 'starting' || job.state === 'running')
    ) {
      job.state = 'cancelled'
      job.endedAt = this.options.now()
    }
    return { ok: true as const }
  }

  readonly readResult = async (input: { jobKey: string }) => {
    const text = this.jobs.get(input.jobKey)?.resultText ?? null
    return text === null ? { found: false } : { found: true, text }
  }

  readonly offerArtifact = async (input: { jobKey: string }) => {
    const bundle = this.jobs.get(input.jobKey)?.bundle ?? null
    if (bundle === null) throw new Error(`no bundle for ${input.jobKey}`)
    return { ticket: this.options.peer.offer(bundle) }
  }

  readonly cleanupJob = async (input: { jobKey: string }) => {
    this.calls.push(`cleanup:${input.jobKey}`)
    const job = this.jobs.get(input.jobKey)
    if (job === undefined || job.datasetDeleted) return { deleted: [] }
    job.datasetDeleted = true
    return { deleted: [`cst-ds-${input.jobKey}`] }
  }

  readonly listJobs = async (input: { entryId?: string }): Promise<readonly ProviderJobStatus[]> =>
    [...this.jobs.values()]
      .filter((j) => !j.datasetDeleted)
      .filter((j) => input.entryId === undefined || j.entryId === input.entryId)
      .map((j) => this.status(j))

  // ── Internals ──────────────────────────────────────────────────────

  private requireEntry(entryId: string): FakeEntrySeed {
    const entry = this.entries.find((e) => e.entryId === entryId)
    if (entry === undefined) throw new Error(`fake provider: unknown entry ${entryId}`)
    return entry
  }

  private require(jobKey: string): FakeCloudJob {
    const job = this.jobs.get(jobKey)
    if (job === undefined) throw new Error(`fake provider: no job ${jobKey}`)
    return job
  }

  private blank(jobKey: string, entryId: string, state: ProviderJobState): FakeCloudJob {
    return {
      jobKey,
      entryId,
      state,
      submits: 0,
      startedAt: state === 'running' ? this.options.now() : null,
      endedAt: null,
      exitCode: null,
      costUsd: 0,
      jobSpecJson: null,
      dataset: null,
      datasetDeleted: false,
      logs: [],
      resultText: null,
      bundle: null,
    }
  }

  private descriptorOf(entry: FakeEntrySeed): TrainingProviderDescriptor {
    return {
      addonId: this.addonId,
      entryId: entry.entryId,
      typeId: FAKE_TYPE_ID,
      name: entry.name,
      iconAsset: FAKE_ICON_ASSET,
      kind: FAKE_TYPE_ID,
      label: 'Fake cloud',
      gpuTypes: [{ id: 'L4', label: 'L4', usdPerHour: 0.8, vramGb: 24 }],
      regions: [{ id: '', label: 'Any', priceMultiplier: 1 }],
      maxDatasetBytes: 10 * 1024 ** 3,
      maxRuntimeSec: 24 * 3600,
      dataResidencyNote: 'The fake keeps everything in memory.',
      configured: entry.configured,
      defaults: {
        gpuType: 'L4',
        region: '',
        costCapUsd: this.options.costCapUsd ?? 5,
        maxRuntimeSec: 4 * 3600,
        failedDatasetGraceHours: this.options.failedDatasetGraceHours ?? 24,
      },
    }
  }

  private status(job: FakeCloudJob): ProviderJobStatus {
    return {
      jobKey: job.jobKey,
      providerJobId: `fake-${job.jobKey}`,
      state: job.state,
      ...(job.startedAt !== null ? { startedAt: job.startedAt } : {}),
      ...(job.endedAt !== null ? { endedAt: job.endedAt } : {}),
      ...(job.exitCode !== null ? { exitCode: job.exitCode } : {}),
      gpuType: 'L4',
      billedSeconds: 0,
      costUsd: job.costUsd,
      costIsEstimate: true,
      lastFetchedAt: this.options.now(),
    }
  }

  private lostStatus(jobKey: string): ProviderJobStatus {
    return {
      jobKey,
      state: 'lost',
      gpuType: 'L4',
      billedSeconds: 0,
      costUsd: 0,
      costIsEstimate: true,
      lastFetchedAt: this.options.now(),
    }
  }
}
