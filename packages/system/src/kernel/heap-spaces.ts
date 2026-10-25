/**
 * heap-spaces — WHERE in the V8 heap the bytes are, on the ordinary heartbeat.
 *
 * ## The question this exists to answer, and why it was unobtainable
 *
 * `hub/recorder` holds ~1.4 GB of live, retained JS heap that nobody can name.
 * That is measured, not inferred: a forced compacting
 * `gc({ flavor: 'last-resort' })` returned 507 MB of RSS and left V8 with
 * 1870 MB committed and 1439 MB of it LIVE forty seconds later. Everything the
 * 2026-08-29 pass could price — index rows 60–67 MB, runner shell ~50 MB, boot
 * parse 35–50 MB transient, write path 0 retained — sums to 115–125 MB, under
 * 9%. The same addon build running as `recorder` on an agent with no cameras
 * and no archive sits at 52 MB.
 *
 * The next question is cheap and binary, and it halves the search:
 *
 *  - **`old_space` holds it** ⇒ millions of small objects. The hunt becomes
 *    "what allocates ~7 M objects", and the row counters the recorder's index
 *    already exposes are the next thing to log.
 *  - **`large_object_space` holds it** ⇒ a handful of objects over V8's
 *    ~128 KB regular-object ceiling. The hunt becomes "who holds one huge array
 *    or string", which is a very short list in any one addon.
 *
 * V8 answers it for free, and this repository has been computing the answer
 * since the SIGUSR2 handler was written — and then throwing it away, because
 * `addon-runner.ts` welded the free read to `v8.writeHeapSnapshot`. One signal,
 * both actions, so the cheap answer could not be had without the expensive one
 * an operator has to authorise on a production hub. {@link emitHeapDiagnosticReport}
 * splits them; this module puts the same breakdown on the periodic `[mem]` line
 * so no signal is needed at all.
 *
 * ## Why bytes and not MB in the model
 *
 * The two consumers want different resolution — the heartbeat wants whole MB
 * next to `heapUsed`, the SIGUSR2 report keeps the 0.1 MB it has always
 * printed — so the reading stays raw and rounding happens at the edge. A model
 * that pre-rounds cannot serve both without lying to one of them.
 */
import * as v8 from 'node:v8'
import type { HeapWatchSink } from './heap-watch.js'

/** One V8 space, as V8 names it, with the bytes it is holding. */
export interface HeapSpaceUsage {
  /** V8's own `space_name`, e.g. `old_space`. Never renamed here. */
  readonly name: string
  readonly usedBytes: number
}

/** A reading of every space. Injectable so a test can pose a known heap state. */
export type HeapSpaceReader = () => readonly HeapSpaceUsage[]

/**
 * The two spaces that ANSWER the question, printed always — including at zero.
 *
 * Node 24 reports thirteen spaces (measured on 24.17: `read_only_space`,
 * `new_space`, `old_space`, `code_space`, `shared_space`, `trusted_space`,
 * `shared_trusted_space`, `new_large_object_space`, `large_object_space`,
 * `code_large_object_space`, `shared_large_object_space`,
 * `shared_trusted_large_object_space`, `trusted_large_object_space`). Printing
 * all thirteen once a minute per process would add ~13 fields to a line that
 * already carries eleven, on every runner, forever — and eleven of the thirteen
 * cannot be the answer to a 1.4 GB retained-set question.
 *
 * These two are printed unconditionally because **absence must never be
 * ambiguous**. A threshold-only rule would drop `large_object_space` at 20 MB,
 * and a reader would not be able to tell "small" from "this build does not
 * report it" — which is the same class of mistake as a heartbeat with no
 * destination (D285). `largeObjectSpace=0MB` is a load-bearing reading: it says
 * the retainer is NOT a handful of huge objects.
 */
export const DECISIVE_HEAP_SPACES: readonly string[] = ['old_space', 'large_object_space']

/**
 * A non-decisive space is printed only once it holds at least this many MB.
 *
 * 32 MB, and the number comes from the smallest heap this line is ever asked to
 * explain: the control in the 2026-08-29 pass is an idle `recorder` runner at
 * **52 MB** of `heapUsed`. A threshold below that means no space that could
 * dominate even the smallest watched process is ever hidden, while a quiet
 * process — measured on a bare Node 24.17: `new_space` 0.7 MB, `code_space`
 * 0.25 MB, `trusted_space` 0.9 MB — prints nothing but the decisive pair.
 *
 * What this drops, and why it is right to drop it: `new_space` is the scavenger's
 * semi-space and is bounded by `--max-semi-space-size`, so it can never be a
 * retained set; `code_space` and `read_only_space` are JIT output and V8's own
 * immutable roots, both bounded by the code that exists rather than by the data
 * it touches; the `shared_*` spaces are empty outside a worker-threads
 * deployment, which this cluster does not run. None of them has ever been the
 * answer to "what is this process holding", and each would cost a field on
 * every `[mem]` line in the fleet.
 *
 * They are not censored, though — a space over the threshold prints, whatever it
 * is. If `code_space` ever reaches 32 MB that is itself the finding.
 */
export const HEAP_SPACE_REPORT_MIN_MB = 32

const BYTES_PER_MB = 1048576

/** Whole MB, matching the rest of the `[mem]` line. */
function mb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB)
}

/** Tenths of an MB — the resolution the SIGUSR2 report has always printed. */
function tenthsMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10
}

/**
 * Read every space from V8.
 *
 * Wrapped: a diagnostic that can crash the process it watches is worse than
 * none, and this is called from a heartbeat whose whole contract is that it
 * survives whatever it is measuring. An empty reading prints no fields, which
 * is exactly what a heartbeat that could not read the heap should say.
 */
export function readHeapSpaces(): readonly HeapSpaceUsage[] {
  try {
    return v8
      .getHeapSpaceStatistics()
      .map((space) => ({ name: space.space_name, usedBytes: space.space_used_size }))
  } catch {
    return []
  }
}

/**
 * `old_space` → `oldSpace`. Mechanical and total, so a space V8 adds tomorrow
 * gets a field name without anyone editing a table.
 *
 * camelCase because that is the vocabulary of every other field on this line
 * (`heapUsed`, `heapTotal`, `arrayBuffers`, `rssBudget`, `loopP99`). A line that
 * mixed `heapUsed=` with `old_space=` would be two conventions for one record.
 */
export function heapSpaceField(v8Name: string): string {
  return v8Name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * The spaces worth a field on this line: the decisive pair (in that order,
 * always), then every other space at or above `minMb`, largest first.
 *
 * Largest-first for the tail because the tail only ever appears when something
 * unexpected is holding memory, and the biggest surprise should be the first
 * thing read. The decisive pair keeps a FIXED position so the two numbers a
 * reader is comparing are always in the same place on every line.
 */
export function selectReportedSpaces(
  spaces: readonly HeapSpaceUsage[],
  minMb: number = HEAP_SPACE_REPORT_MIN_MB,
): readonly HeapSpaceUsage[] {
  const decisive = DECISIVE_HEAP_SPACES.map((name) =>
    spaces.find((space) => space.name === name),
  ).filter((space): space is HeapSpaceUsage => space !== undefined)
  const rest = spaces
    .filter((space) => !DECISIVE_HEAP_SPACES.includes(space.name))
    .filter((space) => mb(space.usedBytes) >= minMb)
    .toSorted((a, b) => b.usedBytes - a.usedBytes || a.name.localeCompare(b.name))
  return [...decisive, ...rest]
}

/**
 * The suffix appended to a `[mem]` line — leading space included, empty when
 * there is nothing to say.
 *
 * APPENDED, never interleaved: every existing field keeps its name AND its
 * position, so a `hl loki-query` pipeline written against the old line still
 * matches. Prefix stability is the only change to a log line that cannot break
 * a query someone already wrote.
 */
export function formatHeapSpaces(
  spaces: readonly HeapSpaceUsage[],
  minMb: number = HEAP_SPACE_REPORT_MIN_MB,
): string {
  const selected = selectReportedSpaces(spaces, minMb)
  if (selected.length === 0) return ''
  return ` ${selected.map((s) => `${heapSpaceField(s.name)}=${mb(s.usedBytes)}MB`).join(' ')}`
}

/** What a diagnostic report is ABOUT. */
export interface HeapDiagnosticRequest {
  /** The runner's nodeId, so the line groups with its `[mem]` heartbeat. */
  readonly label: string
  readonly addons: readonly string[]
  readonly sink: HeapWatchSink
}

/** Everything the report READS. Injected so the split itself is testable. */
export interface HeapDiagnosticDeps {
  readonly readMemory: () => NodeJS.MemoryUsage
  readonly readSpaces: HeapSpaceReader
}

const defaultDeps: HeapDiagnosticDeps = {
  readMemory: () => process.memoryUsage(),
  readSpaces: readHeapSpaces,
}

/**
 * The SIGUSR2 report — memory + the FULL per-space breakdown; never a heap
 * snapshot (D718) — see the note in the body.
 *
 * The breakdown here keeps every non-empty space at 0.1 MB, unlike the
 * heartbeat's filtered whole-MB pair: this is a hand-fired diagnostic read once
 * by a human who asked for it, so completeness costs nothing. The heartbeat runs
 * unattended on every runner forever, so it pays for every field it prints.
 */
export function emitHeapDiagnosticReport(
  request: HeapDiagnosticRequest,
  deps: HeapDiagnosticDeps = defaultDeps,
): void {
  try {
    const mu = deps.readMemory()
    const spaces = deps
      .readSpaces()
      .filter((space) => space.usedBytes > 0)
      .map((space) => `${space.name}=${tenthsMb(space.usedBytes)}`)
      .join(' ')
    request.sink.info(
      `[mem] node="${request.label}" addons=[${request.addons.join(',')}] ` +
        `rss=${tenthsMb(mu.rss)} heapUsed=${tenthsMb(mu.heapUsed)} ` +
        `heapTotal=${tenthsMb(mu.heapTotal)} external=${tenthsMb(mu.external)} ` +
        `arrayBuffers=${tenthsMb(mu.arrayBuffers)} | ${spaces}`,
    )
  } catch (error) {
    request.sink.warn(
      `[mem] node="${request.label}" space report failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // NO SNAPSHOT. SIGUSR2 reports the numbers above and stops there.
  //
  // `v8.writeHeapSnapshot` is a stop-the-world walk plus a multi-gigabyte
  // write, and on this hub it took the machine down twice. The second attempt
  // (2026-09-03, recorder, 1.8 GB heap) did not even finish: it left a 0-byte
  // file and a host the operator had to reboot. An env flag was not enough of
  // a lock — it was set in production, so a single signal was all it took.
  // Naming what is RETAINED now needs a process that is not serving cameras
  // (D718). The allocation-site sampler that was meant to replace it was never
  // wired to a runner and was deleted on 2026-10-06.
}
