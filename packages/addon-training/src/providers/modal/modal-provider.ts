/**
 * The Modal `training-provider` (D807), over {@link ModalGateway}.
 *
 * Per job (tagged with the orchestrator's jobKey everywhere):
 *   - a Volume `cst-ds-<jobKey>` holds `dataset.tar`, `job.json` and `out/`;
 *   - the dataset is streamed into it by a short CPU "staging" sandbox, so a
 *     slow home upload never bills a GPU;
 *   - the trainer runs in ONE GPU sandbox built from the trainer's Dockerfile
 *     at the pinned HF revision, with Modal enforcing `maxRuntimeSec`;
 *   - result.json / bundle.tar are read back by a CPU "collector" sandbox;
 *   - cleanup deletes the Volume. The shared `camstack-training-cache` Volume
 *     (base weights, COCO replay, baseline ONNX) is never deleted.
 *
 * The provider keeps a small ledger (jobKey → sandbox id, start, end) so a
 * hub restart re-attaches by id instead of guessing.
 */
import { createHash } from 'node:crypto'
import type {
  AddonPeerBytes,
  IScopedLogger,
  ITrainingCloudProvider,
  PeerBytesTicket,
  ProviderJobStatus,
  SecretClearInstruction,
  SecretFieldView,
  TrainingCredentialCheck,
  TrainingLogLine,
  TrainingProviderDescriptor,
  TrainingProviderEntry,
  TrainingProviderType,
} from '@camstack/types'
import { isSecretClear } from '@camstack/types'
import { parseTrainerDockerfile, trainerDockerfileUrl } from './dockerfile.js'
import { MODAL_ENTRY_CONFIG_SCHEMA } from './modal-entry-schema.js'
import { MODAL_ICON_ASSET, MODAL_TYPE_ID, type ModalEntryRecord } from './modal-entries.js'
import {
  MODAL_CACHE_VOLUME,
  MODAL_TOOLS_IMAGE,
  ModalAuthError,
  type ModalGateway,
  type ModalSandbox,
} from './modal-gateway.js'
import {
  MODAL_GPUS,
  MODAL_MAX_DATASET_BYTES,
  MODAL_MAX_RUNTIME_SEC,
  MODAL_REGIONS,
  modalPricePerSecond,
} from './modal-pricing.js'

/** Per-entry Modal settings (credentials + job defaults). */
export type ModalSettings = ModalEntryRecord

export interface ModalJobRecord {
  readonly jobKey: string
  readonly entryId: string
  readonly sandboxId: string | null
  readonly gpuType: string
  readonly region: string
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly exitCode: number | null
  /** Ended because WE terminated it (cancel), not because the trainer exited. */
  readonly cancelled: boolean
}

export interface ModalJobLedger {
  get(jobKey: string): Promise<ModalJobRecord | null>
  put(record: ModalJobRecord): Promise<void>
  remove(jobKey: string): Promise<void>
  list(): Promise<readonly ModalJobRecord[]>
}

export interface ModalProviderDeps {
  readonly addonId: string
  readonly listEntries: () => readonly ModalEntryRecord[]
  readonly entry: (entryId: string) => ModalEntryRecord | null
  /** `null` while the entry has no token. */
  readonly gateway: (entryId: string) => ModalGateway | null
  readonly createEntry: (input: { typeId: string; name: string }) => Promise<{ entryId: string }>
  readonly updateEntry: (
    entryId: string,
    patch: {
      name: string
      tokenId?: string
      tokenSecret?: string
      clearTokenSecret?: boolean
      environment?: string
      gpuType?: string
      region?: string
      costCapUsd?: number
      maxRuntimeHours?: number
      failedDatasetGraceHours?: number
    },
  ) => Promise<void>
  readonly deleteEntry: (entryId: string) => Promise<void>
  /** Keychain views for each entry id — never plaintext (D787 / D789). */
  readonly secretViews: () => Promise<ReadonlyMap<string, SecretFieldView | null>>
  readonly ledger: ModalJobLedger
  readonly peer: Pick<AddonPeerBytes, 'open' | 'offer'>
  readonly fetchText: (url: string) => Promise<string>
  readonly now: () => number
  readonly logger: IScopedLogger
}

const STAGING_TIMEOUT_MS = 2 * 60 * 60_000
const COLLECTOR_TIMEOUT_MS = 30 * 60_000
const TRAINER_COMMAND =
  'printf "%s" "$CAMSTACK_JOB_JSON" > /data/job.json && exec python -m camstack_train run --job /data/job.json --dataset /data/dataset.tar --out /data/out --cache /cache'

export const jobVolumeName = (jobKey: string): string => `cst-ds-${jobKey}`
const tagsFor = (jobKey: string): Record<string, string> => ({ camstack: 'training', jobKey })

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Cursor: `<ms of the last line>:<lines already seen at that ms>`. */
function parseCursor(cursor: string | undefined): { readonly ts: number; readonly seen: number } {
  const [ts, seen] = (cursor ?? '0:0').split(':').map(Number)
  return { ts: Number.isFinite(ts) ? (ts ?? 0) : 0, seen: Number.isFinite(seen) ? (seen ?? 0) : 0 }
}

export class ModalTrainingProvider implements ITrainingCloudProvider {
  constructor(private readonly deps: ModalProviderDeps) {}

  readonly describe = async (): Promise<readonly TrainingProviderDescriptor[]> => {
    const views = await this.deps.secretViews()
    return this.deps
      .listEntries()
      .map((entry) => this.descriptorOf(entry, views.get(entry.id) ?? null))
  }

  readonly describeTypes = async (): Promise<readonly TrainingProviderType[]> => [
    {
      typeId: MODAL_TYPE_ID,
      label: 'Modal',
      iconAsset: MODAL_ICON_ASSET,
      addonId: this.deps.addonId,
      configSchema: MODAL_ENTRY_CONFIG_SCHEMA,
    },
  ]

  readonly listEntries = async (): Promise<readonly TrainingProviderEntry[]> =>
    this.deps.listEntries().map((entry) => ({
      entryId: entry.id,
      typeId: MODAL_TYPE_ID,
      name: entry.name,
      addonId: this.deps.addonId,
      configured: this.entryConfigured(entry),
    }))

  readonly createEntry = async (input: { typeId: string; name: string }) =>
    this.deps.createEntry(input)

  readonly updateEntry = async (input: {
    entryId: string
    name: string
    tokenId?: string
    tokenSecret?: string | SecretClearInstruction
    environment?: string
    gpuType?: string
    region?: string
    costCapUsd?: number
    maxRuntimeSec?: number
    failedDatasetGraceHours?: number
  }) => {
    const secret =
      input.tokenSecret === undefined
        ? {}
        : isSecretClear(input.tokenSecret)
          ? { clearTokenSecret: true as const }
          : input.tokenSecret === ''
            ? {}
            : { tokenSecret: input.tokenSecret }
    await this.deps.updateEntry(input.entryId, {
      name: input.name,
      ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
      ...secret,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.gpuType !== undefined ? { gpuType: input.gpuType } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.costCapUsd !== undefined ? { costCapUsd: input.costCapUsd } : {}),
      ...(input.maxRuntimeSec !== undefined ? { maxRuntimeHours: input.maxRuntimeSec / 3600 } : {}),
      ...(input.failedDatasetGraceHours !== undefined
        ? { failedDatasetGraceHours: input.failedDatasetGraceHours }
        : {}),
    })
    return { ok: true as const }
  }

  readonly deleteEntry = async (input: { entryId: string }) => {
    await this.deps.deleteEntry(input.entryId)
    return { ok: true as const }
  }

  readonly validateCredentials = async (input: {
    entryId: string
  }): Promise<TrainingCredentialCheck> => {
    if (this.deps.entry(input.entryId) === null) {
      return { ok: false, reason: 'missing', detail: 'unknown entry' }
    }
    const gateway = this.deps.gateway(input.entryId)
    if (gateway === null)
      return { ok: false, reason: 'missing', detail: 'enter a Modal token id and secret' }
    try {
      const { environment } = await gateway.checkAuth()
      return { ok: true, account: environment }
    } catch (err: unknown) {
      if (err instanceof ModalAuthError)
        return { ok: false, reason: err.reason, detail: err.message }
      return { ok: false, reason: 'network', detail: errText(err) }
    }
  }

  readonly estimateJob = async (input: {
    gpuType: string
    region: string
    gpuSecondsLow: number
    gpuSecondsHigh: number
  }) => {
    const perSec = modalPricePerSecond(input.gpuType, input.region)
    return {
      usdLow: Math.round(perSec * input.gpuSecondsLow * 100) / 100,
      usdHigh: Math.round(perSec * input.gpuSecondsHigh * 100) / 100,
      notes: [
        'Modal list price, billed per second; the dataset upload runs on a CPU sandbox (cents).',
        ...(input.region === ''
          ? []
          : [
              'A pinned region costs more, and whether the Starter plan may pin one is unverified.',
            ]),
      ],
    }
  }

  readonly uploadDataset = async (input: {
    entryId: string
    jobKey: string
    ticket: PeerBytesTicket
  }) => {
    const gateway = this.requireGateway(input.entryId)
    const opened = await this.deps.peer.open(input.ticket)
    if (opened.kind === 'refused')
      throw new Error(`dataset offer refused: ${opened.code} — ${opened.detail}`)
    const staging = await gateway.createSandbox({
      image: { kind: 'registry', tag: MODAL_TOOLS_IMAGE },
      command: ['sleep', String(STAGING_TIMEOUT_MS / 1000)],
      timeoutMs: STAGING_TIMEOUT_MS,
      cpu: 1,
      memoryMiB: 512,
      volumes: { '/data': jobVolumeName(input.jobKey) },
      tags: { ...tagsFor(input.jobKey), role: 'staging' },
    })
    const hash = createHash('sha256')
    let bytes = 0
    async function* measured(): AsyncIterable<Uint8Array> {
      for await (const chunk of opened.kind === 'body' ? opened.body.stream : []) {
        const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk))
        hash.update(buf)
        bytes += buf.length
        yield buf
      }
    }
    try {
      const code = await staging.execWithStdin(
        [
          'sh',
          '-c',
          'cat > /data/dataset.tar.part && mv /data/dataset.tar.part /data/dataset.tar && sync',
        ],
        measured(),
      )
      if (code !== 0)
        throw new Error(`the staging sandbox exited ${String(code)} while writing the dataset`)
    } finally {
      // Terminating commits the Volume.
      await staging.terminate().catch(() => undefined)
    }
    const sha256 = hash.digest('hex')
    this.deps.logger.info('modal dataset uploaded', { meta: { jobKey: input.jobKey, bytes } })
    return { bytes, sha256 }
  }

  readonly submitJob = async (input: {
    entryId: string
    jobKey: string
    trainer: { repo: string; revision: string }
    jobSpecJson: string
    gpuType: string
    region: string
    maxRuntimeSec: number
  }): Promise<ProviderJobStatus> => {
    const existing = await this.deps.ledger.get(input.jobKey)
    if (existing?.sandboxId != null) return this.statusOf(existing)
    const gateway = this.requireGateway(input.entryId)
    const parsed = parseTrainerDockerfile(
      await this.deps.fetchText(trainerDockerfileUrl(input.trainer.repo, input.trainer.revision)),
      input.trainer.revision,
    )
    if (parsed.kind === 'refused')
      throw new Error(`trainer Dockerfile unusable on Modal: ${parsed.detail}`)
    const sandbox = await gateway.createSandbox({
      image: { kind: 'recipe', recipe: parsed.recipe },
      command: ['sh', '-c', TRAINER_COMMAND],
      timeoutMs: Math.min(input.maxRuntimeSec, MODAL_MAX_RUNTIME_SEC) * 1000,
      gpu: input.gpuType,
      ...(input.region !== '' ? { regions: [input.region] } : {}),
      volumes: { '/data': jobVolumeName(input.jobKey), '/cache': MODAL_CACHE_VOLUME },
      env: { CAMSTACK_JOB_JSON: input.jobSpecJson, TRAINER_REVISION: input.trainer.revision },
      tags: { ...tagsFor(input.jobKey), role: 'trainer', entryId: input.entryId },
      name: `cst-${input.jobKey}`,
    })
    const record: ModalJobRecord = {
      jobKey: input.jobKey,
      entryId: input.entryId,
      sandboxId: sandbox.sandboxId,
      gpuType: input.gpuType,
      region: input.region,
      startedAt: this.deps.now(),
      endedAt: null,
      exitCode: null,
      cancelled: false,
    }
    await this.deps.ledger.put(record)
    this.deps.logger.info('modal training sandbox started', {
      meta: {
        jobKey: input.jobKey,
        sandboxId: sandbox.sandboxId,
        gpu: input.gpuType,
        region: input.region || 'any',
      },
    })
    return this.statusOf(record)
  }

  readonly getJob = async (input: {
    entryId: string
    jobKey: string
  }): Promise<ProviderJobStatus> => {
    const record = await this.deps.ledger.get(input.jobKey)
    if (record === null) return this.lost(input.jobKey, input.entryId)
    if (record.sandboxId === null || record.endedAt !== null) return this.statusOf(record)
    const sandbox = await this.requireGateway(record.entryId).sandboxFromId(record.sandboxId)
    if (sandbox === null) return this.lost(input.jobKey, record.entryId)
    const code = await sandbox.poll()
    if (code === null) return this.statusOf(record)
    const ended: ModalJobRecord = { ...record, endedAt: this.deps.now(), exitCode: code }
    await this.deps.ledger.put(ended)
    return this.statusOf(ended)
  }

  readonly listJobEvents = async (input: {
    entryId: string
    jobKey: string
    cursor?: string
    max: number
  }) => {
    const record = await this.deps.ledger.get(input.jobKey)
    const cursor = parseCursor(input.cursor)
    if (record?.sandboxId == null)
      return { lines: [], cursor: `${String(cursor.ts)}:${String(cursor.seen)}` }
    const sandbox = await this.requireGateway(record.entryId).sandboxFromId(record.sandboxId)
    if (sandbox === null)
      return { lines: [], cursor: `${String(cursor.ts)}:${String(cursor.seen)}` }
    const lines: TrainingLogLine[] = []
    let lastTs = cursor.ts
    let atLast = cursor.seen
    let skip = cursor.seen
    for await (const line of sandbox.logsSince(cursor.ts)) {
      if (line.ts === cursor.ts && skip > 0) {
        skip -= 1
        continue
      }
      if (lines.length >= input.max) break
      lines.push({ ts: line.ts, text: line.text })
      atLast = line.ts === lastTs ? atLast + 1 : 1
      lastTs = line.ts
    }
    return { lines, cursor: `${String(lastTs)}:${String(atLast)}` }
  }

  readonly cancelJob = async (input: { entryId: string; jobKey: string }) => {
    const record = await this.deps.ledger.get(input.jobKey)
    if (record?.sandboxId == null || record.endedAt !== null) return { ok: true as const }
    const sandbox = await this.requireGateway(record.entryId).sandboxFromId(record.sandboxId)
    await sandbox?.terminate()
    await this.deps.ledger.put({ ...record, endedAt: this.deps.now(), cancelled: true })
    return { ok: true as const }
  }

  readonly readResult = async (input: { entryId: string; jobKey: string }) => {
    const collector = await this.collector(input.entryId, input.jobKey)
    try {
      const { stdout } = await collector.execText([
        'sh',
        '-c',
        'cat /data/out/result.json 2>/dev/null || true',
      ])
      return stdout.trim() === '' ? { found: false } : { found: true, text: stdout }
    } finally {
      await collector.terminate().catch(() => undefined)
    }
  }

  readonly offerArtifact = async (input: {
    entryId: string
    jobKey: string
    path: 'bundle.tar'
  }) => {
    const logger = this.deps.logger
    const offered = await this.deps.peer.offer({
      label: 'training-bundle',
      handler: async (_req, res) => {
        const collector = await this.collector(input.entryId, input.jobKey)
        try {
          const proc = await collector.execStream(['cat', `/data/out/${input.path}`])
          res.writeHead(200, { 'content-type': 'application/x-tar' })
          for await (const chunk of proc.stdout) {
            if (!res.write(chunk))
              await new Promise<void>((resolve) => res.once('drain', () => resolve()))
          }
          const code = await proc.wait()
          if (code !== 0) throw new Error(`cat exited ${String(code)}`)
          res.end()
        } catch (err: unknown) {
          logger.warn('modal artefact stream failed', {
            meta: { jobKey: input.jobKey, error: errText(err) },
          })
          res.destroy(err instanceof Error ? err : new Error(String(err)))
        } finally {
          await collector.terminate().catch(() => undefined)
        }
      },
    })
    if (offered.kind === 'refused')
      throw new Error(`artefact offer refused: ${offered.code} — ${offered.detail}`)
    return { ticket: offered.ticket }
  }

  readonly cleanupJob = async (input: { entryId: string; jobKey: string }) => {
    const gateway = this.requireGateway(input.entryId)
    const deleted: string[] = []
    for (const sb of await gateway.listSandboxes(tagsFor(input.jobKey))) {
      const handle = await gateway.sandboxFromId(sb.sandboxId)
      await handle?.terminate()
    }
    if (await gateway.deleteVolume(jobVolumeName(input.jobKey)))
      deleted.push(jobVolumeName(input.jobKey))
    await this.deps.ledger.remove(input.jobKey)
    return { deleted }
  }

  readonly listJobs = async (input: {
    entryId?: string
  }): Promise<readonly ProviderJobStatus[]> => {
    const records = (await this.deps.ledger.list()).filter(
      (r) => input.entryId === undefined || r.entryId === input.entryId,
    )
    const known = new Set(records.map((r) => r.jobKey))
    const statuses = await Promise.all(
      records.map((r) => this.getJob({ entryId: r.entryId, jobKey: r.jobKey })),
    )
    const probeEntryId =
      input.entryId ?? this.deps.listEntries().find((e) => this.entryConfigured(e))?.id
    if (probeEntryId === undefined) return statuses
    const gateway = this.deps.gateway(probeEntryId)
    if (gateway === null) return statuses
    const strays = (await gateway.listSandboxes({ camstack: 'training' }))
      .map((s) => s.tags['jobKey'])
      .filter((k): k is string => k !== undefined && !known.has(k))
    const unique = [...new Set(strays)]
    return [
      ...statuses,
      ...unique.map((jobKey) => ({
        ...this.lost(jobKey, probeEntryId),
        state: 'running' as const,
      })),
    ]
  }

  // ── Internals ──────────────────────────────────────────────────────

  private entryConfigured(entry: ModalEntryRecord): boolean {
    const secret = typeof entry.tokenSecret === 'string' ? entry.tokenSecret : ''
    return (entry.tokenId ?? '').trim() !== '' && secret.trim() !== ''
  }

  private descriptorOf(
    entry: ModalEntryRecord,
    tokenSecretView: SecretFieldView | null,
  ): TrainingProviderDescriptor {
    const gpuType = entry.gpuType ?? 'L4'
    const region = entry.region ?? ''
    const costCapUsd = entry.costCapUsd ?? 5
    const maxRuntimeHours = entry.maxRuntimeHours ?? 4
    const failedDatasetGraceHours = entry.failedDatasetGraceHours ?? 24
    return {
      addonId: this.deps.addonId,
      entryId: entry.id,
      typeId: MODAL_TYPE_ID,
      name: entry.name,
      iconAsset: MODAL_ICON_ASSET,
      kind: MODAL_TYPE_ID,
      label: 'Modal',
      gpuTypes: MODAL_GPUS,
      regions: MODAL_REGIONS,
      maxDatasetBytes: MODAL_MAX_DATASET_BYTES,
      maxRuntimeSec: MODAL_MAX_RUNTIME_SEC,
      freeTierNote: 'The Starter plan includes $30 of credit every month; Modal bills per second.',
      dataResidencyNote:
        'Modal keeps the frames on a Volume of your workspace for the length of the job; the training container sees them only while it runs.',
      configured: this.entryConfigured(entry),
      defaults: {
        gpuType,
        region,
        costCapUsd,
        maxRuntimeSec: Math.round(maxRuntimeHours * 3600),
        failedDatasetGraceHours,
      },
      formValues: {
        tokenId: entry.tokenId ?? '',
        tokenSecret: tokenSecretView ?? '',
        environment: entry.environment ?? '',
        gpuType,
        region,
        costCapUsd,
        maxRuntimeHours,
        failedDatasetGraceHours,
      },
    }
  }

  private requireGateway(entryId: string): ModalGateway {
    const gateway = this.deps.gateway(entryId)
    if (gateway === null) throw new Error('Modal is not configured: enter a token id and secret')
    return gateway
  }

  private collector(entryId: string, jobKey: string): Promise<ModalSandbox> {
    return this.requireGateway(entryId).createSandbox({
      image: { kind: 'registry', tag: MODAL_TOOLS_IMAGE },
      command: ['sleep', String(COLLECTOR_TIMEOUT_MS / 1000)],
      timeoutMs: COLLECTOR_TIMEOUT_MS,
      cpu: 1,
      memoryMiB: 512,
      volumes: { '/data': jobVolumeName(jobKey) },
      tags: { ...tagsFor(jobKey), role: 'collector', entryId },
    })
  }

  private statusOf(record: ModalJobRecord): ProviderJobStatus {
    const now = this.deps.now()
    const end = record.endedAt ?? now
    const seconds = record.startedAt === null ? 0 : Math.max(0, (end - record.startedAt) / 1000)
    const state =
      record.sandboxId === null
        ? 'pending'
        : record.endedAt === null
          ? 'running'
          : record.cancelled
            ? 'cancelled'
            : record.exitCode === 0
              ? 'succeeded'
              : 'failed'
    return {
      jobKey: record.jobKey,
      ...(record.sandboxId !== null ? { providerJobId: record.sandboxId } : {}),
      state,
      ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
      ...(record.endedAt !== null ? { endedAt: record.endedAt } : {}),
      ...(record.exitCode !== null ? { exitCode: record.exitCode } : {}),
      gpuType: record.gpuType,
      ...(record.region !== '' ? { region: record.region } : {}),
      billedSeconds: Math.round(seconds),
      costUsd:
        Math.round(seconds * modalPricePerSecond(record.gpuType, record.region) * 10_000) / 10_000,
      costIsEstimate: true,
      lastFetchedAt: now,
    }
  }

  private lost(jobKey: string, entryId: string): ProviderJobStatus {
    const entry = this.deps.entry(entryId)
    return {
      jobKey,
      state: 'lost',
      gpuType: entry?.gpuType ?? 'L4',
      billedSeconds: 0,
      costUsd: 0,
      costIsEstimate: true,
      lastFetchedAt: this.deps.now(),
    }
  }
}
