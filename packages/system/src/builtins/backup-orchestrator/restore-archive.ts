/**
 * Turn a downloaded backup into the plain `.tar.gz` the boot-time restore
 * extracts (`server/backend/src/pending-restore.ts`, unchanged).
 *
 * An encrypted archive is decrypted HERE, before the restart, with the backup
 * secret key the operator typed into the restore dialog: the launcher runs
 * before any runner and has no way to ask for a key. The plaintext lands only
 * in the hub's private staging directory (0600), where the restore marker
 * points at it, and is swept with the rest of staging once consumed.
 *
 * A plain archive — every backup made before encryption, or with it off — is
 * used as it is: existing backups stay restorable.
 */
import * as fsp from 'node:fs/promises'
import {
  BackupKeyMismatchError,
  decryptBackupFile,
  parseBackupSecretKey,
  readBackupEncryptionHeader,
} from '../system-backup/backup-encryption.js'

/** An encrypted backup was asked to restore without its key. */
export class BackupKeyRequiredError extends Error {
  constructor(readonly keyId: string) {
    super(`this backup is encrypted to backup key ${keyId} — enter that key's secret to restore it`)
    this.name = 'BackupKeyRequiredError'
  }
}

/**
 * Before downloading gigabytes: does the operator's key fit what the
 * destination's manifest says the archive needs? `archiveKeyId` undefined =
 * the manifest records no encryption (the header check after the download
 * remains the authority).
 */
export function precheckRestoreKey(
  archiveKeyId: string | undefined,
  secretKey: string | undefined,
): void {
  if (archiveKeyId === undefined) return
  if (secretKey === undefined || secretKey.trim().length === 0) {
    throw new BackupKeyRequiredError(archiveKeyId)
  }
  const given = parseBackupSecretKey(secretKey).keyId
  if (given !== archiveKeyId) throw new BackupKeyMismatchError(archiveKeyId, given)
}

export interface PrepareRestoreInput {
  /** The archive as downloaded from the destination. Consumed (deleted or renamed). */
  readonly downloaded: string
  /** Where the restore marker will point: a plain `.tar.gz`. */
  readonly target: string
  readonly secretKey?: string
}

export interface PreparedRestore {
  readonly encrypted: boolean
  readonly keyId?: string
}

export async function prepareRestoreArchive(input: PrepareRestoreInput): Promise<PreparedRestore> {
  let header: { readonly keyId: string } | null
  try {
    header = await readBackupEncryptionHeader(input.downloaded)
  } catch (err: unknown) {
    await fsp.rm(input.downloaded, { force: true })
    throw err
  }
  if (header === null) {
    await fsp.rename(input.downloaded, input.target)
    return { encrypted: false }
  }
  try {
    if (input.secretKey === undefined || input.secretKey.trim().length === 0) {
      throw new BackupKeyRequiredError(header.keyId)
    }
    await decryptBackupFile(input.downloaded, input.target, input.secretKey)
    return { encrypted: true, keyId: header.keyId }
  } finally {
    await fsp.rm(input.downloaded, { force: true })
  }
}
