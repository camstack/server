/** Fakes for the gated model tools: a hub that records reads, a mutator that records writes. */
import type { OpsHub, OpsMutator } from '../ops/hub.js'
import type { AuditRecord } from '../mutations/gate.js'

export interface FakeHub extends OpsHub {
  readonly queries: { path: string; input: unknown }[]
  readonly downloads: { urlPath: string; destFile: string; maxBytes: number }[]
}

export function fakeHub(
  answers: Record<string, unknown>,
  tier: 'admin' | 'protected' = 'admin',
): FakeHub {
  const queries: { path: string; input: unknown }[] = []
  const downloads: { urlPath: string; destFile: string; maxBytes: number }[] = []
  return {
    server: 'https://hub.example.test',
    tier,
    source: 'session',
    adminHint: null,
    queries,
    downloads,
    async query(path, input) {
      queries.push({ path, input })
      if (!(path in answers)) throw new Error(`unexpected query ${path}`)
      return answers[path]
    },
    async download(urlPath, destFile, maxBytes) {
      downloads.push({ urlPath, destFile, maxBytes })
      return { bytes: 1234 }
    },
  }
}

export interface FakeMutator extends OpsMutator {
  readonly calls: { path: string; input: unknown }[]
}

export function fakeMutator(answers: Record<string, unknown> = {}): FakeMutator {
  const calls: { path: string; input: unknown }[] = []
  return {
    server: 'https://hub.example.test',
    tier: 'admin',
    calls,
    async mutate(path, input) {
      calls.push({ path, input })
      if (!(path in answers)) throw new Error(`unexpected mutation ${path}`)
      return answers[path]
    },
  }
}

export function auditLog(): { records: AuditRecord[]; sink: (r: AuditRecord) => void } {
  const records: AuditRecord[] = []
  return { records, sink: (r) => records.push(r) }
}

export const PREFLIGHT_OK = {
  canStart: true,
  online: true,
  estimatedDurationMs: 600_000,
  budgetMs: 2_700_000,
  moving: [{ deviceId: 101, placedOnNode: true, pinnedToNode: false }],
  staying: [],
  headroom: { sessionsNow: 4, otherNodesCapacitySessions: 12 },
  refusals: [],
}

export const PREFLIGHT_BLOCKED = {
  ...PREFLIGHT_OK,
  canStart: false,
  refusals: [
    { kind: 'insufficient-headroom', detail: 'others cannot absorb 4 cameras', overridable: true },
  ],
}

export const PLAN = {
  nodeId: 'unraid-1',
  devices: [{ deviceKey: 'openvino:GPU', modelIds: ['yolov9m-320-int8'] }],
}
