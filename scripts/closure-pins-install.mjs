#!/usr/bin/env node
/**
 * closure-pins-install — pin a REGISTRY install of `@camstack/server` to the
 * third-party versions its release was tested with (#681).
 *
 *   node scripts/closure-pins-install.mjs <dir> [version-or-tag]   # default tag: latest
 *
 * For the Docker image and the desktop build, which install the closure with a
 * bare `npm install @camstack/server@…` outside the node updater. It resolves
 * the version ONCE, packs that exact version, reads `package/closure-pins.json`
 * out of the tarball and writes it as `overrides` into `<dir>/package.json`
 * (npm honours `overrides` only in the root project). A missing or invalid file
 * leaves the install unpinned and says why on stderr; it never fails.
 *
 * stdout carries ONE line, the resolved version: the caller installs
 * `@camstack/server@<that line>` so pack and install see the same release.
 * Runs on a bare Node 24 (type stripping reads the shared parser), no workspace build.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  fetchClosurePins,
  isRejectedPinsMiss,
  withClosureOverrides,
} from '../packages/node-root/src/closure-pins.ts'

const execFileAsync = promisify(execFile)
const SERVER_PACKAGE = '@camstack/server'
const NPM_TIMEOUT_MS = 180_000

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

/**
 * Resolve `versionOrTag` once, pin `dir/package.json`, return the exact version.
 * `run` and `log` are injectable for tests.
 */
export async function pinClosureInstall({ dir, versionOrTag = 'latest', run = runNpm, log = console.error }) {
  const viewed = await run(['view', `${SERVER_PACKAGE}@${versionOrTag}`, 'version', '--json'], {
    cwd: dir,
    timeoutMs: NPM_TIMEOUT_MS,
  })
  const parsed = JSON.parse(viewed.stdout.trim())
  const version = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`cannot resolve ${SERVER_PACKAGE}@${versionOrTag}: npm view returned ${viewed.stdout.trim()}`)
  }

  let pins = null
  let reason = null
  try {
    const read = await fetchClosurePins(run, SERVER_PACKAGE, version, [], dir)
    pins = read.pins
    reason = read.miss === null ? null : `${read.miss}${isRejectedPinsMiss(read.miss) ? ' (shipped file refused)' : ''}`
  } catch (err) {
    reason = `pack failed: ${err instanceof Error ? err.message : String(err)}`
  }

  const manifestPath = path.join(dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  fs.writeFileSync(manifestPath, `${JSON.stringify(withClosureOverrides(manifest, pins), null, 2)}\n`)
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
  pinClosureInstall({ dir: path.resolve(dir), versionOrTag })
    .then(({ version }) => process.stdout.write(`${version}\n`))
    .catch((err) => {
      console.error(`[closure-pins] FAILED: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
