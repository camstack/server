#!/usr/bin/env node
/**
 * closure-pins-install — pin a REGISTRY install of `@dominevo/server` to the
 * third-party versions its release was tested with (#681).
 *
 *   node scripts/closure-pins-install.mjs <dir> [version-or-tag]   # default tag: latest
 *
 * For the Docker image and the desktop build, which install the closure with a
 * bare `npm install @dominevo/server@…` outside the node updater. It resolves
 * the version ONCE, packs that exact version, reads `package/closure-pins.json`
 * out of the tarball and writes it as `overrides` into `<dir>/package.json`
 * (npm honours `overrides` only in the root project). Anything that goes wrong
 * leaves the install unpinned and says why on stderr; only a failed write of
 * `<dir>/package.json` is fatal.
 *
 * stdout carries ONE line, the version to install (the tag itself when the
 * registry could not resolve it): the caller installs
 * `@dominevo/server@<that line>` so pack and install see the same release.
 * Runs on a bare Node 24 (type stripping reads the shared parser), no workspace build.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Load the shared parser. node-root's package.json is typeless, so Node warns
 * MODULE_TYPELESS_PACKAGE_JSON when it reparses the `.ts`; that one warning is
 * dropped for the import only, the package type stays as it is.
 */
async function importClosurePins() {
  const emit = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    const code = typeof rest[0] === 'object' && rest[0] !== null ? rest[0].code : rest[1]
    if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return
    return emit.call(process, warning, ...rest)
  }
  try {
    return await import('../packages/node-root/src/closure-pins.ts')
  } finally {
    process.emitWarning = emit
  }
}
const { fetchClosurePins, isRejectedPinsMiss, withClosureOverrides } = await importClosurePins()

const execFileAsync = promisify(execFile)
const SERVER_PACKAGE = '@dominevo/server'
const NPM_TIMEOUT_MS = 180_000
const VIEW_ATTEMPTS = 3

const message = (err) => (err instanceof Error ? err.message : String(err))

/** Real `npm` runner: `{ cwd, timeoutMs }` as `fetchClosurePins` expects. */
export async function runNpm(args, opts) {
  const win = process.platform === 'win32'
  const { stdout } = await execFileAsync(win ? 'npm.cmd' : 'npm', [...args], {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    shell: win,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { stdout: String(stdout) }
}

/** `npm view` with a few attempts; `version: null` when the registry never answered. */
async function resolveVersion({ dir, versionOrTag, run, sleep, retryDelayMs }) {
  let last = 'no attempt'
  for (let attempt = 1; attempt <= VIEW_ATTEMPTS; attempt += 1) {
    try {
      const viewed = await run(['view', `${SERVER_PACKAGE}@${versionOrTag}`, 'version', '--json'], {
        cwd: dir,
        timeoutMs: NPM_TIMEOUT_MS,
      })
      const parsed = JSON.parse(viewed.stdout.trim())
      const version = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
      if (typeof version === 'string' && version.length > 0) return { version, reason: null }
      last = `npm view returned ${viewed.stdout.trim()}`
    } catch (err) {
      last = message(err)
    }
    if (attempt < VIEW_ATTEMPTS) await sleep(retryDelayMs)
  }
  return {
    version: null,
    reason: `cannot resolve ${SERVER_PACKAGE}@${versionOrTag} after ${VIEW_ATTEMPTS} attempts: ${last}`,
  }
}

/**
 * Resolve `versionOrTag` once, pin `dir/package.json`, return the version to
 * install. Everything but a failed package.json WRITE degrades to an unpinned
 * install. `run`, `log`, `sleep` are injectable for tests.
 */
export async function pinClosureInstall({
  dir,
  versionOrTag = 'latest',
  run = runNpm,
  log = console.error,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelayMs = 2000,
}) {
  const resolved = await resolveVersion({ dir, versionOrTag, run, sleep, retryDelayMs })
  if (resolved.version === null) {
    log(`[closure-pins] ${SERVER_PACKAGE}@${versionOrTag} installs UNPINNED: ${resolved.reason}`)
    return { version: versionOrTag, pinned: false }
  }
  const version = resolved.version

  let pins = null
  let reason = null
  try {
    const read = await fetchClosurePins(run, SERVER_PACKAGE, version, [], dir)
    pins = read.pins
    reason =
      read.miss === null
        ? null
        : `${read.miss}${isRejectedPinsMiss(read.miss) ? ' (shipped file refused)' : ''}`
  } catch (err) {
    reason = `pack failed: ${message(err)}`
  }

  const manifestPath = path.join(dir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    pins = null
    reason = `cannot read ${manifestPath}: ${message(err)}`
  }
  if (manifest !== null) {
    try {
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify(withClosureOverrides(manifest, pins), null, 2)}\n`,
      )
    } catch (err) {
      throw new Error(`cannot write ${manifestPath}: ${message(err)}`)
    }
  }
  if (pins === null) {
    log(`[closure-pins] ${SERVER_PACKAGE}@${version} installs UNPINNED: ${reason}`)
  } else {
    log(
      `[closure-pins] ${SERVER_PACKAGE}@${version} pinned: ${Object.keys(pins).length} third-party versions written as overrides`,
    )
  }
  return { version, pinned: pins !== null }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [dir, versionOrTag] = process.argv.slice(2)
  if (dir === undefined) {
    console.error('usage: closure-pins-install.mjs <dir> [version-or-tag]')
    process.exit(2)
  }
  const retryDelayMs = Number(process.env.CLOSURE_PINS_RETRY_MS ?? 2000)
  pinClosureInstall({ dir: path.resolve(dir), versionOrTag, retryDelayMs })
    .then(({ version }) => process.stdout.write(`${version}\n`))
    .catch((err) => {
      console.error(`[closure-pins] FATAL: ${message(err)}`)
      process.exit(1)
    })
}
