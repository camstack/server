/**
 * Hand a password or a saved Amazon session to the Python worker as an
 * owner-only file. The path travels on stdin. The bytes never travel on
 * argv or in the environment, and they are removed when the call settles.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { restrictDirToOwnerSync, writeOwnerOnlyFileSync } from '@camstack/types/node'

const REDACTED = '‹redacted›'

export interface SpeakSecretPaths {
  readonly dir: string
  readonly passwordPath: string
  readonly sessionPath: string
}

export interface SpeakSecretInput {
  readonly password: string
  /** Base64 of the cookie blob alexapy last wrote. Empty when there is none. */
  readonly sessionB64: string
}

export interface SpeakSecretResult {
  /** Base64 of whatever the worker left in the session file (may be unchanged). */
  readonly sessionB64: string
}

function decodeSession(sessionB64: string): Buffer {
  if (sessionB64.length === 0) return Buffer.alloc(0)
  return Buffer.from(sessionB64, 'base64')
}

async function readSessionB64(sessionPath: string): Promise<string> {
  const bytes = await fs.readFile(sessionPath)
  if (bytes.length === 0) return ''
  return bytes.toString('base64')
}

/**
 * Create a 0700 directory, write the password and the session 0600, run
 * `body`, then delete the directory whether `body` succeeded or threw.
 * Returns the session file as base64 so the caller can store it in the keychain.
 */
export async function withSpeakSecretFiles(
  input: SpeakSecretInput,
  body: (paths: SpeakSecretPaths) => Promise<void>,
): Promise<SpeakSecretResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camstack-alexa-'))
  const paths: SpeakSecretPaths = {
    dir,
    passwordPath: path.join(dir, 'password'),
    sessionPath: path.join(dir, 'session'),
  }
  try {
    restrictDirToOwnerSync(dir)
    writeOwnerOnlyFileSync(paths.passwordPath, input.password)
    writeOwnerOnlyFileSync(paths.sessionPath, decodeSession(input.sessionB64))
    await body(paths)
    return { sessionB64: await readSessionB64(paths.sessionPath) }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Replace every occurrence of each non-empty secret. Used before a log line is emitted. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join(REDACTED)
  }
  return out
}
