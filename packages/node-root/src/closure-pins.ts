/**
 * Closure pins (#681). `@camstack/server` ships `closure-pins.json`: every
 * third-party package of its production closure at the exact version the repo
 * lockfile tested. A registry install in the staging dir writes it as
 * `overrides` so nothing published after the release can enter the closure.
 *
 * npm honours `overrides` only in the ROOT project — never in a dependency's
 * package.json — and a shrinkwrap inside the server nests the whole tree under
 * it and drops the addons, so the installer has to carry the pins itself.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

export const CLOSURE_PINS_FILE = 'closure-pins.json'

export type ClosurePins = Readonly<Record<string, string>>

/** `npm pack` runner: the service's own `execNpm`, so the registry args and the test stub apply. */
export type PackRunner = (
  args: readonly string[],
  opts: { readonly cwd?: string; readonly timeoutMs: number },
) => Promise<{ readonly stdout: string }>

const TAR_BLOCK = 512
const PACK_TIMEOUT_MS = 120_000

/** Read one file out of a gzipped npm tarball; `null` when it is not there. */
export function readTarballEntry(tgz: Buffer, entryPath: string): Buffer | null {
  const tar = zlib.gunzipSync(tgz)
  let offset = 0
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every((byte) => byte === 0)) return null
    const nameEnd = header.indexOf(0)
    const name = header.toString('utf8', 0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd)
    const size = Number.parseInt(header.toString('ascii', 124, 135).trim(), 8)
    if (!Number.isFinite(size)) return null
    const start = offset + TAR_BLOCK
    if (name === entryPath) return tar.subarray(start, start + size)
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return null
}

/** Why a target installs unpinned. The last three mean a pins file WAS shipped and was refused. */
export type ClosurePinsMiss =
  | 'no-tarball'
  | 'entry-missing'
  | 'unparseable'
  | 'non-exact-version'
  | 'empty'

export type ClosurePinsRead =
  | { readonly pins: ClosurePins; readonly miss: null }
  | { readonly pins: null; readonly miss: ClosurePinsMiss }

/** A shipped pins file the installer refused: a broken file must not pass for an old release. */
export function isRejectedPinsMiss(miss: ClosurePinsMiss): boolean {
  return miss === 'unparseable' || miss === 'non-exact-version' || miss === 'empty'
}

/** Parse a pins file; anything but `{ name: exact-version }` is refused, with the reason. */
export function parseClosurePins(raw: string): ClosurePinsRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { pins: null, miss: 'unparseable' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { pins: null, miss: 'unparseable' }
  }
  const pins: Record<string, string> = {}
  for (const [name, version] of Object.entries(parsed)) {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
      return { pins: null, miss: 'non-exact-version' }
    }
    if (name.startsWith('@camstack/')) continue
    pins[name] = version
  }
  return Object.keys(pins).length === 0 ? { pins: null, miss: 'empty' } : { pins, miss: null }
}

/**
 * Pins of `<packageName>@<target>` as published: `npm pack` it into a temp dir
 * (the install that follows reads the same tarball from npm's cache) and read
 * `package/closure-pins.json`. `pins: null` carries the `miss` reason: this
 * target ships none (an older server), or the file was refused. A pack that
 * throws propagates; the caller installs unpinned and says so.
 */
export async function fetchClosurePins(
  execNpm: PackRunner,
  packageName: string,
  target: string,
  registryArgs: readonly string[],
  /** The staging dir: the pack then sees the same `.npmrc` as the install that follows. */
  cwd: string,
): Promise<ClosurePinsRead> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-pins-'))
  try {
    await execNpm(
      [
        'pack',
        `${packageName}@${target}`,
        '--pack-destination',
        dir,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        ...registryArgs,
      ],
      { cwd, timeoutMs: PACK_TIMEOUT_MS },
    )
    const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'))
    if (tgz === undefined) return { pins: null, miss: 'no-tarball' }
    const entry = readTarballEntry(
      fs.readFileSync(path.join(dir, tgz)),
      `package/${CLOSURE_PINS_FILE}`,
    )
    if (entry === null) return { pins: null, miss: 'entry-missing' }
    return parseClosurePins(entry.toString('utf8'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The manifest with `overrides` set to the pins. Without pins the previous
 * `overrides` (a seeded manifest may carry the last release's) are dropped, so
 * a stale pin never outlives its release.
 */
export function withClosureOverrides(
  manifest: Readonly<Record<string, unknown>>,
  pins: ClosurePins | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...manifest }
  delete next['overrides']
  return pins === null ? next : { ...next, overrides: pins }
}
