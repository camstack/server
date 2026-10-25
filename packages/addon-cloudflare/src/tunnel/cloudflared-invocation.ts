/**
 * How `cloudflared` is invoked, kept pure so the "no secret on argv, in env
 * or in logs" rule is testable (D783).
 *
 * The named-tunnel token is a bearer credential for the whole tunnel. It
 * travels in a 0600 file passed with `--token-file` (cloudflared ≥ 2025.4.0),
 * written right before each spawn and deleted when the child exits. It is
 * never put on argv (visible to every process via `ps` / /proc) and never in
 * the environment (inherited by children, dumped by crash reporters).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { mkdirOwnerOnlySync, writeOwnerOnlyFileSync } from '@camstack/types/node'

/** First cloudflared release that understands `tunnel run --token-file`. */
export const MIN_TOKEN_FILE_VERSION: readonly [number, number, number] = [2025, 4, 0]

const TOKEN_FILE_NAME = 'tunnel-token'

export interface CloudflaredArgsConfig {
  readonly mode: 'quick' | 'custom'
  readonly debugLogging: boolean
  readonly protocol: 'auto' | 'http2' | 'quic'
  readonly localHost: string
  readonly localPort: number
  readonly noTLSVerify: boolean
  readonly originServerName: string
}

/**
 * Build the cloudflared argv. A named tunnel gets `--token-file <path>`; the
 * caller owns writing and deleting that file. Throws when a named tunnel has
 * no token file — there is deliberately no argv fallback.
 */
export function buildCloudflaredArgs(
  config: CloudflaredArgsConfig,
  tokenFilePath: string | null,
): readonly string[] {
  // Debug logging flags must come BEFORE the `tunnel` sub-command —
  // cloudflared parses global flags only when they precede positional args.
  const debugFlags = config.debugLogging
    ? ['--loglevel', 'debug', '--transport-loglevel', 'debug']
    : []
  // `--protocol` is a `tunnel` sub-command flag, so it goes AFTER `tunnel`
  // but BEFORE `run`/`--url`. `auto` is the cloudflared default and is
  // omitted so a server-side setting from the dashboard is not overridden.
  const protocolFlag =
    config.protocol && config.protocol !== 'auto' ? ['--protocol', config.protocol] : []

  if (config.mode === 'quick') {
    // The hub origin speaks HTTPS with a self-signed cert, so the quick-tunnel
    // `--url` uses `https://` and carries the same origin-TLS overrides the
    // named path applies via `originRequest`.
    return [
      ...debugFlags,
      'tunnel',
      ...protocolFlag,
      ...(config.noTLSVerify ? ['--no-tls-verify'] : []),
      ...(config.originServerName ? ['--origin-server-name', config.originServerName] : []),
      '--url',
      `https://${config.localHost || '127.0.0.1'}:${config.localPort}`,
    ]
  }

  if (!tokenFilePath) {
    throw new Error('cloudflared: a named tunnel needs a token file — refusing to spawn')
  }
  return [...debugFlags, 'tunnel', ...protocolFlag, 'run', '--token-file', tokenFilePath]
}

/**
 * Write the tunnel token to `<dir>/tunnel-token`, owner-only. The directory is
 * created 0700. A file left behind by a crash is overwritten and re-tightened.
 * Returns the file path (safe to log — it is not the content).
 */
export function writeTokenFile(dir: string, token: string): string {
  mkdirOwnerOnlySync(dir)
  const file = tokenFileIn(dir)
  // Atomic, and re-restricted every time: an existing file keeps its old
  // permissions, and on Windows `mode` is not a permission at all.
  writeOwnerOnlyFileSync(file, token)
  return file
}

/** Where {@link writeTokenFile} puts the token inside `dir`. */
export function tokenFileIn(dir: string): string {
  return path.join(dir, TOKEN_FILE_NAME)
}

/** Delete the token file. Idempotent: a missing file is not an error. */
export function removeTokenFile(file: string): void {
  fs.rmSync(file, { force: true })
}

/** Parse `cloudflared version 2025.4.2 (built …)` into `[2025, 4, 2]`. */
export function parseCloudflaredVersion(output: string): readonly [number, number, number] | null {
  const m = /(\d{4})\.(\d{1,2})\.(\d+)/.exec(output)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** True when the parsed version is ≥ {@link MIN_TOKEN_FILE_VERSION}. */
export function supportsTokenFile(version: readonly [number, number, number] | null): boolean {
  if (!version) return false
  for (let i = 0; i < 3; i++) {
    const a = version[i] ?? 0
    const b = MIN_TOKEN_FILE_VERSION[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}
