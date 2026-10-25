/**
 * Spawn the embedded Python bridge once per source fetch.
 * Errors from a non-zero exit or `{ ok: false }` propagate — never silent [].
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WasteFetchResultSchema,
  type WasteCollectionEntry,
  type WasteFetchResult,
} from './waste-types.js'

export interface FetchSourceDeps {
  readonly pythonPath: string
  /** Absolute path to `python/fetch_source.py`. */
  readonly scriptPath: string
  readonly timeoutMs?: number
}

export interface FetchSourceInput {
  readonly source: string
  readonly args: Readonly<Record<string, unknown>>
}

const DEFAULT_TIMEOUT_MS = 120_000

export function defaultScriptPath(fromModuleUrl: string = import.meta.url): string {
  // In the built addon the script stays next to the package root under python/.
  // Dev: this file lives in src/; dist: in dist/. Walk up until python/ exists
  // is the caller's job — the addon passes an absolute path from package root.
  const here = dirname(fileURLToPath(fromModuleUrl))
  return join(here, '../python/fetch_source.py')
}

export async function fetchWasteSource(
  deps: FetchSourceDeps,
  input: FetchSourceInput,
): Promise<readonly WasteCollectionEntry[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const payload = JSON.stringify({ source: input.source, args: input.args })

  const result = await new Promise<WasteFetchResult>((resolve, reject) => {
    const child = spawn(deps.pythonPath, [deps.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`waste fetch timed out after ${timeoutMs}ms (${input.source})`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const trimmed = stdout.trim()
      if (!trimmed) {
        reject(
          new Error(
            `waste fetch produced no stdout (exit ${code ?? 'null'}): ${stderr.trim() || 'no stderr'}`,
          ),
        )
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        reject(
          new Error(
            `waste fetch returned non-JSON (exit ${code ?? 'null'}): ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        return
      }
      const checked = WasteFetchResultSchema.safeParse(parsed)
      if (!checked.success) {
        reject(new Error(`waste fetch schema mismatch: ${checked.error.message}`))
        return
      }
      if (!checked.data.ok) {
        const detail = stderr.trim() ? ` — ${stderr.trim().slice(0, 500)}` : ''
        reject(new Error(`${checked.data.error}${detail}`))
        return
      }
      if (code !== 0) {
        reject(
          new Error(
            `waste fetch exit ${code} despite ok:true (${input.source}): ${stderr.trim().slice(0, 500)}`,
          ),
        )
        return
      }
      resolve(checked.data)
    })
    child.stdin.write(payload)
    child.stdin.end()
  })

  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.entries
}
