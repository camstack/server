/**
 * Read the keychain master key a DESKTOP app handed this hub over an inherited
 * pipe (D788): `--keychain-key-fd=<n>` names the descriptor, the parent wrote
 * the key (base64) and closed it. Read once, at boot, before anything else
 * can — then the descriptor is closed and the key lives only in memory, in
 * the platform-key slot the keychain builtin reads.
 *
 * An env var was rejected: a child's environment is readable by every process
 * of the same user and is inherited by every addon runner the hub forks.
 */
import * as fs from 'node:fs'
import { setPlatformKeychainKey } from '@camstack/system'

const FD_ARG = '--keychain-key-fd='
const KEY_BYTES = 32

/** The OS keychain's name, for the Secrets page. */
function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS Keychain'
    case 'win32':
      return 'Windows DPAPI'
    default:
      return 'OS secret service'
  }
}

export type PlatformKeyLoad =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly label: string }
  | { readonly kind: 'failed'; readonly error: string }

/** Parse the descriptor number out of argv; `null` when not passed. */
export function keychainKeyFdFromArgv(argv: readonly string[]): number | null {
  const arg = argv.find((a) => a.startsWith(FD_ARG))
  if (arg === undefined) return null
  const n = Number(arg.slice(FD_ARG.length))
  return Number.isInteger(n) && n > 2 ? n : null
}

export function loadPlatformKeychainKey(
  argv: readonly string[] = process.argv,
  readFd: (fd: number) => string = (fd) => fs.readFileSync(fd, 'utf8'),
  closeFd: (fd: number) => void = (fd) => fs.closeSync(fd),
): PlatformKeyLoad {
  const fd = keychainKeyFdFromArgv(argv)
  if (fd === null) return { kind: 'none' }
  try {
    const key = Buffer.from(readFd(fd).trim(), 'base64')
    if (key.length !== KEY_BYTES) return { kind: 'failed', error: 'not 32 bytes of key material' }
    const label = platformLabel(process.platform)
    setPlatformKeychainKey({ label, key })
    return { kind: 'loaded', label }
  } catch (err: unknown) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      closeFd(fd)
    } catch {
      /* already closed */
    }
  }
}
