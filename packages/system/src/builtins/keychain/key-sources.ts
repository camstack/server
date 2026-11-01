/**
 * Where the master key comes from (D788, amended by D991). FIXED paths only —
 * no config key, NO env var carries a key or a key path:
 *
 *  1. `/run/secrets/camstack-master-key` — primary when the file EXISTS at boot
 *     (the Docker / Compose secrets convention; Unraid and Proxmox bind-mount a
 *     file there). A file outside the data volume: a whole-volume backup then
 *     holds the ciphertext but not the key. CamStack only READS it — it is
 *     never written and never created.
 *  2. The desktop app's OS keychain (`safeStorage`), handed to the hub over an
 *     inherited pipe. Primary on a desktop hub with no mounted key file.
 *  3. `<dataDir>/.keychain/master.key` (0600, directory 0700), generated on
 *     first boot. The fallback: it protects CamStack's own backups and stray
 *     database copies (it is NOT in `DEFAULT_BACKUP_LOCATIONS`), but a tar of
 *     the whole data directory carries key and database together, and the
 *     Secrets page says so.
 *
 * `/run/secrets/camstack-master-key.previous` is consulted only to UNLOCK — so a
 * move from one external key to another is a restart plus `rotateMasterKey`,
 * with no window where neither key works.
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

/** The directory the mounted key files live in (injectable for specs, never an env var). */
export const DEFAULT_SECRETS_DIR = '/run/secrets'
/** The mounted primary key file, under the secrets directory. */
export const MOUNTED_KEY_FILE_NAME = 'camstack-master-key'
/** The mounted unlock-only key file, under the secrets directory. */
export const PREVIOUS_MOUNTED_KEY_FILE_NAME = 'camstack-master-key.previous'
/** Absolute form of both, for messages. */
export const MOUNTED_KEY_FILE_PATH: string = `${DEFAULT_SECRETS_DIR}/${MOUNTED_KEY_FILE_NAME}`
export const PREVIOUS_MOUNTED_KEY_FILE_PATH: string = `${DEFAULT_SECRETS_DIR}/${PREVIOUS_MOUNTED_KEY_FILE_NAME}`

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
  readonly dataDir: string
  /** Where the mounted key files live. Defaults to {@link DEFAULT_SECRETS_DIR}. */
  readonly secretsDir?: string | undefined
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** Every candidate, primary first. */
export async function buildKeySourceCandidates(
  opts: KeySourceOptions,
): Promise<readonly KeySourceCandidate[]> {
  const out: KeySourceCandidate[] = []
  const secretsDir = opts.secretsDir ?? DEFAULT_SECRETS_DIR
  const mountedFile = path.join(secretsDir, MOUNTED_KEY_FILE_NAME)
  const previousFile = path.join(secretsDir, PREVIOUS_MOUNTED_KEY_FILE_NAME)
  const defaultFile = defaultKeyFilePath(opts.dataDir)
  const platform = getPlatformKeychainKey()
  const hasMounted = await fileExists(mountedFile)
  const hasPrevious = await fileExists(previousFile)

  const primaryKind: KeychainKeySourceKind = hasMounted
    ? 'mounted-file'
    : platform !== null
      ? 'platform'
      : 'default-file'

  if (hasMounted) {
    out.push({
      source: fileSource('mounted-file', mountedFile, false),
      primary: true,
      load: () => loadKeyFile(mountedFile),
    })
  }
  if (hasPrevious) {
    out.push({
      source: fileSource('previous-mounted-file', previousFile, false),
      primary: false,
      load: () => loadKeyFile(previousFile),
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
