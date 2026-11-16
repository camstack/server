/**
 * Where the bundled worker is, and how the local account's password reaches it: an owner-only
 * file in a fresh 0700 directory whose PATH travels on stdin, removed when the call settles —
 * never argv, never the environment (camstack-secrets).
 */
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restrictDirToOwnerSync, writeOwnerOnlyFileSync } from '@camstack/types/node'

const WORKER = 'unifi_worker.py'

/** `python/unifi_worker.py` next to `dist/` in a deployed package, or beside `src/` under test. */
export function resolveUnifiWorkerScript(fromModuleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(fromModuleUrl))
  const candidates = [join(here, '../python', WORKER), join(here, '../../python', WORKER)]
  for (const file of candidates) if (existsSync(file)) return file
  throw new Error(`provider-unifi: ${WORKER} not found. Searched:\n${candidates.join('\n')}`)
}

/** Run `body` with the secret in a 0600 file; the directory is removed whether it succeeded or threw. */
export async function withSecretFile<T>(
  secret: string,
  body: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'camstack-unifi-'))
  try {
    restrictDirToOwnerSync(dir)
    const path = join(dir, 'password')
    writeOwnerOnlyFileSync(path, secret)
    return await body(path)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** The seam the client writes its secret through; tests pass one that records the call. */
export type UnifiSecretFiles = <T>(secret: string, body: (path: string) => Promise<T>) => Promise<T>
