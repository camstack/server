/**
 * The Modal provider wired to the recorded gateway, shared by the contract
 * suite and the Modal-specific spec.
 */
import type { ITrainingCloudProvider } from '@camstack/types'
import { MemoryPeerBytes } from '../providers/fake/memory-peer-bytes.js'
import { DEFAULT_MODAL_ENTRY_NAME, MODAL_TYPE_ID } from '../providers/modal/modal-entries.js'
import {
  type ModalJobLedger,
  type ModalJobRecord,
  ModalTrainingProvider,
} from '../providers/modal/modal-provider.js'
import { FakeModalGateway } from './fake-modal-gateway.js'
import { silentLogger } from './harness.js'

export const JOB = '22222222-2222-4222-8222-222222222222'
export const MODAL_ENTRY_ID = 'modal-entry-default'
const DOCKERFILE = [
  'FROM pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime',
  'ARG TRAINER_REVISION=main',
  'RUN pip install "camstack-train @ git+https://huggingface.co/camstack/camstack-trainer@${TRAINER_REVISION}"',
].join('\n')

export class MemoryLedger implements ModalJobLedger {
  readonly rows = new Map<string, ModalJobRecord>()
  async get(jobKey: string) {
    return this.rows.get(jobKey) ?? null
  }
  async put(record: ModalJobRecord) {
    this.rows.set(record.jobKey, record)
  }
  async remove(jobKey: string) {
    this.rows.delete(jobKey)
  }
  async list() {
    return [...this.rows.values()]
  }
}

export interface Subject {
  readonly provider: ITrainingCloudProvider
  readonly addonId: string
  readonly entryId: string
  readonly peer: MemoryPeerBytes
  /** Make the started job emit lines and finish with a result. */
  readonly finish: (lines: readonly string[]) => void
}

export function modalSubject(): Subject & { gateway: FakeModalGateway } {
  let now = 1000
  const peer = new MemoryPeerBytes()
  const gateway = new FakeModalGateway(() => now)
  const entry = {
    id: MODAL_ENTRY_ID,
    name: DEFAULT_MODAL_ENTRY_NAME,
    tokenId: 'ak-x',
    tokenSecret: 'as-y',
    environment: '',
    gpuType: 'L4',
    region: '',
    costCapUsd: 5,
    maxRuntimeHours: 4,
    failedDatasetGraceHours: 24,
  }
  let entries = [entry]
  const provider = new ModalTrainingProvider({
    addonId: 'training-modal',
    listEntries: () => entries,
    entry: (entryId) => entries.find((e) => e.id === entryId) ?? null,
    gateway: (entryId) => (entryId === MODAL_ENTRY_ID ? gateway : null),
    createEntry: async (input) => {
      if (input.typeId !== MODAL_TYPE_ID) throw new Error('unknown type')
      const id = `modal-${String(entries.length + 1)}`
      entries = [
        ...entries,
        {
          ...entry,
          id,
          name: input.name,
          tokenId: '',
          tokenSecret: '',
        },
      ]
      return { entryId: id }
    },
    updateEntry: async (entryId, patch) => {
      entries = entries.map((e) =>
        e.id === entryId
          ? {
              ...e,
              name: patch.name,
              ...(patch.tokenId !== undefined ? { tokenId: patch.tokenId } : {}),
              ...(patch.clearTokenSecret === true
                ? { tokenSecret: '' }
                : patch.tokenSecret !== undefined && patch.tokenSecret !== ''
                  ? { tokenSecret: patch.tokenSecret }
                  : {}),
              ...(patch.environment !== undefined ? { environment: patch.environment } : {}),
              ...(patch.gpuType !== undefined ? { gpuType: patch.gpuType } : {}),
              ...(patch.region !== undefined ? { region: patch.region } : {}),
              ...(patch.costCapUsd !== undefined ? { costCapUsd: patch.costCapUsd } : {}),
              ...(patch.maxRuntimeHours !== undefined
                ? { maxRuntimeHours: patch.maxRuntimeHours }
                : {}),
              ...(patch.failedDatasetGraceHours !== undefined
                ? { failedDatasetGraceHours: patch.failedDatasetGraceHours }
                : {}),
            }
          : e,
      )
    },
    deleteEntry: async (entryId) => {
      entries = entries.filter((e) => e.id !== entryId)
    },
    secretViews: async () => {
      const map = new Map<string, import('@camstack/types').SecretFieldView | null>()
      for (const e of entries) {
        const secret = typeof e.tokenSecret === 'string' ? e.tokenSecret : ''
        map.set(
          e.id,
          secret.trim() !== '' ? { $secret: null, v: 1, set: true, inline: true } : null,
        )
      }
      return map
    },
    ledger: new MemoryLedger(),
    peer: { open: (t) => peer.open(t), offer: (o) => peer.offerHandler(o) },
    fetchText: async () => DOCKERFILE,
    now: () => now,
    logger: silentLogger(),
  })
  return {
    provider,
    addonId: 'training-modal',
    entryId: MODAL_ENTRY_ID,
    peer,
    gateway,
    finish: (lines) => {
      now += 1
      gateway.finishTrainer(
        JOB,
        {
          'out/result.json': Buffer.from('{"status":"succeeded"}'),
          'out/bundle.tar': Buffer.from('b'),
        },
        0,
        lines,
      )
    },
  }
}
