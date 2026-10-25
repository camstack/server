/**
 * The node benchmark's three durable collections (D791), all owned by the
 * orchestrator — the placement authority that enters and leaves benchmark
 * mode, and the one writer of the results Auto tune and the shares read.
 *
 *  - the MANIFEST: one row, written BEFORE benchmark mode changes anything
 *    and removed only after the cluster is restored. Its presence at boot or
 *    on a reconcile with no live run means "restore now".
 *  - the RUNS: what each run did and why it ended (bounded history).
 *  - the RESULTS: one row per measured cell.
 *
 * ## Records migration (phase 2, steps 13-15)
 *
 * The store now reads and writes via `ctx.records` (RecordKindHandle) instead
 * of the SettingsStore DurableLedger. The three kinds are declared at boot via
 * `ctx.records.declare(orchestratorRecordKinds)` before this class is
 * constructed. No static `declare` method — the caller's responsibility.
 *
 * Legacy rows stored `{ body: <JSON_object>, at: number }` with a JSON column.
 * The adoption mappers unwrap `body` to produce the new flat row. The new
 * PUT writes the manifest/run/result directly as the record data.
 */
import {
  type IScopedLogger,
  type NodeBenchmarkManifest,
  NodeBenchmarkManifestSchema,
  type NodeBenchmarkResult,
  NodeBenchmarkResultSchema,
  type NodeBenchmarkRun,
  NodeBenchmarkRunSchema,
  type RecordsAccess,
} from '@camstack/types'
import { orchestratorRecordKinds } from '../record-kinds.js'

// Re-export for the adoption script.
export {
  NODE_BENCHMARK_MODE_COLLECTION,
  NODE_BENCHMARK_RESULTS_COLLECTION,
  NODE_BENCHMARK_RUNS_COLLECTION,
} from '../record-kinds.js'

const MANIFEST_KEY = 'active'
export const MAX_RUNS = 50
export const MAX_RESULTS = 500

/** The persistence the benchmark service needs — a seam for tests. */
export interface NodeBenchmarkPersistence {
  /** Load everything from the store (boot). */
  load(): Promise<void>
  readManifest(): NodeBenchmarkManifest | null
  /** Persist FIRST; throws when the store refuses (then nothing changes). */
  writeManifest(manifest: NodeBenchmarkManifest): Promise<void>
  clearManifest(): Promise<void>
  recordRun(run: NodeBenchmarkRun): Promise<void>
  listRuns(): readonly NodeBenchmarkRun[]
  writeResults(rows: readonly NodeBenchmarkResult[]): Promise<void>
  listResults(): readonly NodeBenchmarkResult[]
  deleteResult(id: string): Promise<boolean>
}

/** Keep the newest `max` rows by `at`; the rest are the ones to drop. */
export function overflow<T>(rows: readonly T[], max: number, at: (row: T) => number): readonly T[] {
  if (rows.length <= max) return []
  return rows.toSorted((a, b) => at(b) - at(a)).slice(max)
}

export class NodeBenchmarkStore implements NodeBenchmarkPersistence {
  private readonly modeKind: ReturnType<RecordsAccess['kind']>
  private readonly runsKind: ReturnType<RecordsAccess['kind']>
  private readonly resultsKind: ReturnType<RecordsAccess['kind']>

  private _manifest: NodeBenchmarkManifest | null = null
  private _runs: NodeBenchmarkRun[] = []
  private _results: NodeBenchmarkResult[] = []

  constructor(deps: { readonly records: RecordsAccess; readonly logger: IScopedLogger }) {
    this.modeKind = deps.records.kind(orchestratorRecordKinds['node-benchmark-mode'])
    this.runsKind = deps.records.kind(orchestratorRecordKinds['node-benchmark-runs'])
    this.resultsKind = deps.records.kind(orchestratorRecordKinds['node-benchmarks'])
  }

  async load(): Promise<void> {
    const [manifestRow, runsPage, resultsPage] = await Promise.all([
      this.modeKind.get(MANIFEST_KEY),
      this.runsKind.query({ limit: MAX_RUNS * 2 }),
      this.resultsKind.query({ limit: MAX_RESULTS * 2 }),
    ])

    if (manifestRow !== null) {
      const parsed = NodeBenchmarkManifestSchema.safeParse(manifestRow.data)
      this._manifest = parsed.success ? parsed.data : null
    } else {
      this._manifest = null
    }

    const runs: NodeBenchmarkRun[] = []
    for (const record of runsPage.records) {
      const parsed = NodeBenchmarkRunSchema.safeParse(record.data)
      if (parsed.success) runs.push(parsed.data)
    }
    this._runs = runs

    const results: NodeBenchmarkResult[] = []
    for (const record of resultsPage.records) {
      const parsed = NodeBenchmarkResultSchema.safeParse(record.data)
      if (parsed.success) results.push(parsed.data)
    }
    this._results = results
  }

  readManifest(): NodeBenchmarkManifest | null {
    return this._manifest
  }

  async writeManifest(manifest: NodeBenchmarkManifest): Promise<void> {
    await this.modeKind.put({ id: MANIFEST_KEY, data: manifest })
    this._manifest = manifest
  }

  async clearManifest(): Promise<void> {
    await this.modeKind.delete(MANIFEST_KEY)
    this._manifest = null
  }

  async recordRun(run: NodeBenchmarkRun): Promise<void> {
    await this.runsKind.put({ id: run.runId, at: run.startedAtMs, data: run })
    this._runs = [run, ...this._runs.filter((r) => r.runId !== run.runId)]
    for (const old of overflow(this._runs, MAX_RUNS, (r) => r.startedAtMs)) {
      this._runs = this._runs.filter((r) => r.runId !== old.runId)
      await this.runsKind.delete(old.runId)
    }
  }

  listRuns(): readonly NodeBenchmarkRun[] {
    return this._runs.toSorted((a, b) => b.startedAtMs - a.startedAtMs)
  }

  async writeResults(rows: readonly NodeBenchmarkResult[]): Promise<void> {
    for (const row of rows) {
      await this.resultsKind.put({ id: row.id, at: row.measuredAtMs, data: row })
      this._results = [row, ...this._results.filter((r) => r.id !== row.id)]
    }
    for (const old of overflow(this._results, MAX_RESULTS, (r) => r.measuredAtMs)) {
      this._results = this._results.filter((r) => r.id !== old.id)
      await this.resultsKind.delete(old.id)
    }
  }

  listResults(): readonly NodeBenchmarkResult[] {
    return this._results.toSorted((a, b) => b.measuredAtMs - a.measuredAtMs)
  }

  async deleteResult(id: string): Promise<boolean> {
    if (!this._results.some((r) => r.id === id)) return false
    await this.resultsKind.delete(id)
    this._results = this._results.filter((r) => r.id !== id)
    return true
  }
}
