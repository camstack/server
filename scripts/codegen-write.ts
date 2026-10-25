/**
 * writeIfChanged — idempotent file write for the codegen generators.
 *
 * Every codegen script previously did an unconditional
 * `fs.writeFileSync(OUTPUT, content)`. That rewrites the file (new
 * mtime + a fresh inode-level change event) even when the generated
 * content is byte-identical to what's already on disk.
 *
 * The dev hub runs under `tsx watch`. The generated files
 * (`server/backend/src/api/trpc/generated-*.ts`,
 * `packages/types/src/generated/*`) sit inside the hub's watched
 * dependency graph — so an unconditional rewrite triggers a full hub
 * restart even when `npm run codegen` produced no actual change.
 * During a session with many codegen runs that's a restart storm:
 * the broker bounces, every agent group-runner flaps, the pipeline
 * churns.
 *
 * `writeIfChanged` reads the existing file, compares, and skips the
 * write when identical. A no-op codegen run now touches zero files →
 * zero hub restarts. A real cap change still writes (and restarts,
 * correctly).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface WriteResult {
  readonly path: string
  readonly changed: boolean
}

/**
 * Write `content` to `filePath` only if it differs from what's on
 * disk. Creates parent directories as needed. Returns whether a
 * write actually happened.
 */
export function writeIfChanged(filePath: string, content: string): WriteResult {
  let existing: string | null = null
  try {
    existing = fs.readFileSync(filePath, 'utf-8')
  } catch {
    // Missing file → treat as changed.
  }
  if (existing === content) {
    return { path: filePath, changed: false }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return { path: filePath, changed: true }
}
