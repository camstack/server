/**
 * Where the master key comes from (D788). Configuration only — NO env var
 * carries a key or a key path:
 *
 *  1. `keychain.keyFile` in `config.yaml` — a file outside the data volume
 *     (a read-only bind mount, a Docker secret). Recommended: a whole-volume
 *     backup then holds the ciphertext but not the key.
 *  2. The desktop app's OS keychain (`safeStorage`), handed to the hub over an
 *     inherited pipe. Primary on a desktop hub with no key file configured.
 *  3. `<dataDir>/.keychain/master.key` (0600, directory 0700), generated on
 *     first boot. The fallback: it protects CamStack's own backups and stray
 *     database copies (it is NOT in `DEFAULT_BACKUP_LOCATIONS`), but a tar of
 *     the whole data directory carries key and database together, and the
 *     Secrets page says so.
 *
 * `keychain.previousKeyFile` is consulted only to UNLOCK — so a move from one
 * key to another is a restart plus `rotateMasterKey`, with no window where
 * neither key works.
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { KeychainKeySource, KeychainKeySourceKind } from '@camstack/types'
import {
  restrictDirToOwnerSync,
  restrictFileToOwnerSync,
  writeOwnerOnlyFileSync,
} from '@camstack/types/node'
import { decodeKeyMaterial, encodeKeyMaterial } from './keychain-crypto.js'
import { getPlatformKeychainKey } from './platform-key-source.js'

/** The `keychain` section of `config.yaml`. */
export interface KeychainKeyConfig {
  readonly keyFile?: string | undefined
  readonly previousKeyFile?: string | undefined
}

export type KeyLoadResult =
  | { readonly kind: 'loaded'; readonly key: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }

export interface KeySourceCandidate {
  readonly source: KeychainKeySource
  readonly primary: boolean
  load(): Promise<KeyLoadResult>
}

/** The default key file's location under the data root. */
export function defaultKeyFilePath(dataDir: string): string {
  return path.join(dataDir, '.keychain', 'master.key')
}

async function loadKeyFile(file: string): Promise<KeyLoadResult> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err: unknown) {
    const code: unknown =
      err !== null && typeof err === 'object' ? Reflect.get(err, 'code') : undefined
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }
  }
  const key = decodeKeyMaterial(text)
  return key === null
    ? { kind: 'unreadable', error: 'not 32 bytes of base64 or hex key material' }
    : { kind: 'loaded', key }
}

function fileSource(
  kind: KeychainKeySourceKind,
  file: string,
  sharesBackupWithDatabase: boolean,
): KeychainKeySource {
  return { kind, path: file, sharesBackupWithDatabase }
}

export interface KeySourceOptions {
  readonly config: KeychainKeyConfig
  readonly dataDir: string
}

/** Every candidate, primary first. */
export function buildKeySourceCandidates(opts: KeySourceOptions): readonly KeySourceCandidate[] {
  const out: KeySourceCandidate[] = []
  const defaultFile = defaultKeyFilePath(opts.dataDir)
  const platform = getPlatformKeychainKey()
  const keyFile = opts.config.keyFile?.trim()
  const previousKeyFile = opts.config.previousKeyFile?.trim()

  const primaryKind: KeychainKeySourceKind =
    keyFile !== undefined && keyFile.length > 0
      ? 'config-file'
      : platform !== null
        ? 'platform'
        : 'default-file'

  if (keyFile !== undefined && keyFile.length > 0) {
    out.push({
      source: fileSource('config-file', keyFile, false),
      primary: true,
      load: () => loadKeyFile(keyFile),
    })
  }
  if (previousKeyFile !== undefined && previousKeyFile.length > 0) {
    out.push({
      source: fileSource('previous-config-file', previousKeyFile, false),
      primary: false,
      load: () => loadKeyFile(previousKeyFile),
    })
  }
  if (platform !== null) {
    out.push({
      source: { kind: 'platform', sharesBackupWithDatabase: false },
      primary: primaryKind === 'platform',
      load: async () => ({ kind: 'loaded', key: platform.key }),
    })
  }
  out.push({
    source: fileSource('default-file', defaultFile, true),
    primary: primaryKind === 'default-file',
    load: () => loadKeyFile(defaultFile),
  })
  return out
}

/**
 * Write a master key to the default location: directory 0700, file 0600,
 * atomically (temp + rename), never over an existing file unless `replace`.
 * Returns the previous file's new name when one was moved aside.
 */
export async function writeDefaultKeyFile(
  dataDir: string,
  key: Buffer,
  opts: { readonly replace: boolean; readonly nowMs: number },
): Promise<string | null> {
  const file = defaultKeyFilePath(dataDir)
  try {
    return await writeKeyFileAt(file, key, opts)
  } catch (err: unknown) {
    // Name the path: "EACCES mkdir" alone does not say WHICH key went nowhere.
    throw new Error(
      `could not write the master key at ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

async function writeKeyFileAt(
  file: string,
  key: Buffer,
  opts: { readonly replace: boolean; readonly nowMs: number },
): Promise<string | null> {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  restrictDirToOwnerSync(dir)
  let movedAside: string | null = null
  try {
    await fsp.access(file)
    if (!opts.replace) throw new Error(`refusing to overwrite the existing master key at ${file}`)
    movedAside = `${file}.prev-${opts.nowMs}`
    await fsp.copyFile(file, movedAside)
    restrictFileToOwnerSync(movedAside)
  } catch (err: unknown) {
    const code: unknown =
      err !== null && typeof err === 'object' ? Reflect.get(err, 'code') : undefined
    if (code !== 'ENOENT') throw err
  }
  writeOwnerOnlyFileSync(file, `${encodeKeyMaterial(key)}\n`)
  // Read it back: a key that is not on disk exactly as generated must never
  // get a wrapped data key stored against it.
  const back = await loadKeyFile(file)
  if (back.kind !== 'loaded' || !back.key.equals(key)) {
    throw new Error('the written key file does not read back as the generated key')
  }
  return movedAside
}
