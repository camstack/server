/**
 * Path and identity helpers for the SMB provider.
 *
 * Two of these exist because `smbclient` is driven through a COMMAND STRING,
 * not an argument vector: `samba-client` builds `-c "<verb> <args>"` and hands
 * the whole thing to the binary, which parses it again. Anything that reaches
 * a remote path from outside — a `relativePath` the caller chose — therefore
 * has to be refused before it becomes part of that string.
 */

/**
 * Characters that would break out of, or corrupt, the `-c "<verb> <args>"`
 * command string smbclient re-parses.
 *
 * Refusing is the only safe option here: there is no escaping convention this
 * provider could apply that smbclient's own parser is guaranteed to undo the
 * same way. Every path CamStack itself generates (archive names are a UUID and
 * a timestamp) passes untouched, so the refusal costs nothing real.
 */
const FORBIDDEN_PATH_CHARS = /["'`$;&|<>\r\n\\]/

/** A path segment that would escape the location's own base. */
const TRAVERSAL_SEGMENT = /(^|\/)\.\.(\/|$)/

/**
 * Validate a caller-supplied relative path, returning it normalised to
 * forward slashes.
 */
export function safeSmbRelativePath(relativePath: string): string {
  if (relativePath.length === 0) return ''
  if (FORBIDDEN_PATH_CHARS.test(relativePath)) {
    throw new Error(
      `smb-storage: relativePath contains a character that cannot be passed to smbclient safely ` +
        `(one of " ' \` $ ; & | < > backslash or a newline). Refusing rather than escaping it.`,
    )
  }
  if (TRAVERSAL_SEGMENT.test(relativePath)) {
    throw new Error(`smb-storage: relativePath "${relativePath}" escapes the location base`)
  }
  return relativePath.replace(/^\/+/, '')
}

/** `//host/share` — the address `smbclient` takes. */
export function smbAddress(host: string, share: string): string {
  return `//${host}/${share}`
}

/**
 * Normalise a base path inside the share for COMPARISON, not for use:
 * lower-cased, slash-normalised, no leading or trailing slash. SMB is
 * case-insensitive, so `Backups` and `backups` are the same directory.
 */
export function normalizedBasePath(basePath: string): string {
  return basePath
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

/**
 * The identity of the PHYSICAL directory a location occupies.
 *
 * Two location records pointing at one directory is the hazard that has no
 * equivalent for a local disk: each carries its own retention policy and each
 * rewrites the destination's manifest, so the second one's sweep deletes
 * archives the first one still lists — and a restore then fails on a file the
 * manifest swears is present. Host and share are compared case-insensitively
 * because SMB is.
 */
export function shareIdentity(input: {
  readonly host: string
  readonly share: string
  readonly basePath: string
}): string {
  return `${input.host.toLowerCase()}/${input.share.toLowerCase()}/${normalizedBasePath(input.basePath)}`
}

/** Split a remote path into its directory segments, ignoring empties. */
export function pathSegments(remotePath: string): readonly string[] {
  return remotePath.split('/').filter((s) => s.length > 0)
}

/**
 * Turn a directory path into the MASK `smbclient dir` needs to enumerate it.
 *
 * `samba-client`'s `list(x)` runs `smbclient -c 'dir x'`, and smbclient's
 * `dir` argument is a wildcard mask evaluated against the current directory —
 * it does NOT descend into a directory named by it. A bare directory path
 * therefore returns that directory's own entry, and an empty string returns
 * nothing at all, because an empty mask matches nothing.
 *
 * Measured on the hub, 2026-09-07: `backups:smb` held a 387 MB archive and a
 * `manifests.json`; `storage.list` answered `[]` and `storage.exists`
 * answered `false`, so every SMB upload was refused by its own post-transfer
 * "did it land?" check even though the bytes were intact on the share. The
 * unit suite was green because its fake client treated the argument as a
 * directory — the fake supplied the semantics production assumed and
 * smbclient does not have.
 *
 * @param dir `''` for the connection's basePath, else a relative directory.
 */
export function listMaskFor(dir: string): string {
  return dir === '' ? '*' : `${dir}/*`
}
