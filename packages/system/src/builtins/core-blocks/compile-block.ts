/**
 * Compiling a core block's TypeScript before it is stored or run.
 *
 * Two callers, one implementation on purpose: the editor asks as the author
 * types, and the store asks before it writes. **The verdict has to be the same
 * one**, or the editor green-lights code the server later refuses — the failure
 * shape where a person is told everything is fine by the thing they are looking
 * at.
 *
 * This is a TRANSPILE / BUNDLE, not a typecheck: esbuild strips types and
 * reports syntax errors, which is what stops unrunnable source from reaching
 * disk. Type errors are the editor's job (Monaco runs the real compiler against
 * the real `.d.ts` graph); doing it again here would mean shipping tsc into the
 * hub for an answer the author already has.
 *
 * Single-file blocks use `transform`. Multi-file projects write sources to a
 * temp dir and `build` from `entry` so relative imports resolve.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type CoreBlockCompileResult,
  DEFAULT_CORE_BLOCK_ENTRY,
  resolveCoreBlockEntry,
} from '@camstack/types'

/** The esbuild surface this needs — injected so the compile is testable and so
 *  the kernel does not hard-depend on a bundler at import time. */
export interface BlockTranspiler {
  transform(
    code: string,
    options: { loader: 'ts'; format: 'esm'; target: string },
  ): Promise<{ code: string }>
  /**
   * Multi-file bundle. Absent on a node that only got `transform` (tests that
   * never exercise files); then a files compile answers "unavailable".
   */
  build?(options: BlockBundleOptions): Promise<BlockBundleResult>
}

export interface BlockBundleOptions {
  readonly absWorkingDir: string
  readonly entryPoints: readonly string[]
  readonly outfile: string
  readonly bundle: true
  readonly format: 'esm'
  readonly platform: 'node'
  readonly target: string
  readonly write: true
  readonly logLevel: 'silent'
}

export interface BlockBundleResult {
  readonly errors: readonly { text: string; location?: { line: number; column: number } | null }[]
}

export interface CompileBlockFilesInput {
  readonly files: Readonly<Record<string, string>>
  readonly entry?: string
}

export type CompileBlockSource = string | CompileBlockFilesInput

export interface CompileBlockResult extends CoreBlockCompileResult {
  /** The emitted JavaScript, when it compiled. */
  readonly js?: string
}

/** An esbuild error carries the position; the shape is narrow enough to read
 *  defensively rather than to type against the package. */
function positionOf(err: unknown): { line?: number; column?: number } {
  if (err === null || typeof err !== 'object') return {}
  const errors = (err as { errors?: unknown }).errors
  if (!Array.isArray(errors) || errors.length === 0) return {}
  const location = (errors[0] as { location?: unknown }).location
  if (location === null || typeof location !== 'object') return {}
  const l = location as { line?: unknown; column?: unknown }
  return {
    ...(typeof l.line === 'number' ? { line: l.line } : {}),
    ...(typeof l.column === 'number' ? { column: l.column } : {}),
  }
}

function messageOf(err: unknown): string {
  if (err === null || typeof err !== 'object') return String(err)
  const errors = (err as { errors?: unknown }).errors
  if (Array.isArray(errors) && errors.length > 0) {
    const text = (errors[0] as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return err instanceof Error ? err.message : String(err)
}

function isFilesInput(source: CompileBlockSource): source is CompileBlockFilesInput {
  return typeof source === 'object' && source !== null && 'files' in source
}

/**
 * Never throws. A compile failure is an ANSWER — the author needs to read it,
 * and a thrown error at this layer becomes a 500 with the useful part buried.
 */
export async function compileBlock(
  transpiler: BlockTranspiler,
  source: CompileBlockSource,
): Promise<CompileBlockResult> {
  if (isFilesInput(source)) {
    return compileFiles(transpiler, source.files, source.entry)
  }
  return compileSingle(transpiler, source)
}

async function compileSingle(
  transpiler: BlockTranspiler,
  code: string,
): Promise<CompileBlockResult> {
  // Empty source is not a syntax error to a transpiler, but a block that
  // exports nothing can never be started — better answered here than by a
  // runner that forks a process and finds nothing to call.
  if (code.trim().length === 0) {
    return { ok: false, error: 'the block is empty — it must export a default function' }
  }
  try {
    const out = await transpiler.transform(code, { loader: 'ts', format: 'esm', target: 'node22' })
    return { ok: true, js: out.code }
  } catch (err) {
    return { ok: false, error: messageOf(err), ...positionOf(err) }
  }
}

async function compileFiles(
  transpiler: BlockTranspiler,
  files: Readonly<Record<string, string>>,
  entryPath: string | undefined,
): Promise<CompileBlockResult> {
  const entry = resolveCoreBlockEntry(entryPath)
  const entrySource = files[entry]
  if (entrySource === undefined) {
    return { ok: false, error: `files must include the entry "${entry}"` }
  }
  if (entrySource.trim().length === 0 && Object.keys(files).length === 1) {
    return { ok: false, error: 'the block is empty — it must export a default function' }
  }
  // One file and no relative imports: the transform path is enough and keeps
  // tests that only stub `transform` working for the legacy shape.
  if (Object.keys(files).length === 1 && !/\bfrom\s+['"]\.\.?\//.test(entrySource)) {
    return compileSingle(transpiler, entrySource)
  }
  if (typeof transpiler.build !== 'function') {
    return {
      ok: false,
      error: 'the multi-file bundler is unavailable on this node',
    }
  }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'core-block-compile-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.resolve(work, rel)
      if (!abs.startsWith(work + path.sep) && abs !== work) {
        return { ok: false, error: `refusing path outside the block package: ${rel}` }
      }
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
    }
    const outfile = path.join(work, '.bundle', 'block.js')
    await fs.mkdir(path.dirname(outfile), { recursive: true })
    const result = await transpiler.build({
      absWorkingDir: work,
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      write: true,
      logLevel: 'silent',
    })
    if (result.errors.length > 0) {
      const first = result.errors[0]!
      return {
        ok: false,
        error: first.text,
        ...(first.location ? { line: first.location.line, column: first.location.column } : {}),
      }
    }
    const js = await fs.readFile(outfile, 'utf-8')
    if (js.trim().length === 0) {
      return { ok: false, error: 'the block is empty — it must export a default function' }
    }
    return { ok: true, js }
  } catch (err) {
    return { ok: false, error: messageOf(err), ...positionOf(err) }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { DEFAULT_CORE_BLOCK_ENTRY }
