import type { IScopedLogger } from '@camstack/types'

export interface PythonDepsLike {
  readonly ensurePython: () => Promise<string | null>
}

export interface PythonReadiness {
  readonly pythonPath: string | null
  readonly ok: boolean
}

/**
 * Resolve the embedded Python once, turning the null/throw failure modes into
 * an explicit, logged result. Python is a hard prerequisite for every runtime;
 * a silent miss here is what produced the "probe empty → bad offer" symptom.
 */
export async function ensurePythonReady(
  deps: PythonDepsLike,
  log: IScopedLogger,
): Promise<PythonReadiness> {
  try {
    const pythonPath = await deps.ensurePython()
    if (!pythonPath) {
      log.error('Embedded Python unavailable — inference runtimes cannot be provisioned', {})
      return { pythonPath: null, ok: false }
    }
    log.info('Embedded Python ready', { meta: { pythonPath } })
    return { pythonPath, ok: true }
  } catch (err: unknown) {
    log.error('Embedded Python provisioning threw', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return { pythonPath: null, ok: false }
  }
}
