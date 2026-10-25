/**
 * Hand the Tailscale auth key to `tailscale up` without putting it on argv
 * or in the environment (D783).
 *
 * The CLI accepts `--auth-key=file:<path>` and reads the key from that file.
 * The key is written owner-only (0600) into a fresh owner-only (0700) temp
 * dir, the flag is handed to `run`, and the dir is removed when `run`
 * settles — success or failure. Error text is passed through
 * {@link scrubSecret} so a `Command failed: …` message can never carry it.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { restrictDirToOwnerSync, writeOwnerOnlyFileSync } from '@camstack/types/node'

const REDACTED = '‹redacted›'

export async function withAuthKeyFile<T>(
  authKey: string,
  run: (authKeyFlag: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camstack-ts-'))
  try {
    restrictDirToOwnerSync(dir)
    const file = path.join(dir, 'authkey')
    writeOwnerOnlyFileSync(file, authKey)
    return await run(`--auth-key=file:${file}`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Replace every occurrence of `secret` in `text`. Empty secrets are a no-op. */
export function scrubSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join(REDACTED)
}
