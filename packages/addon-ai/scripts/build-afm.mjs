#!/usr/bin/env node
/**
 * Build the Apple Foundation Models helper (`native/afm/camstack-afm`).
 *
 * The binary is COMMITTED and shipped in the npm tarball (`files: native`), the
 * `addon-pipeline` Swift precedent: a Mac node may have only the Command Line
 * Tools with an older SDK, so it never compiles anything itself.
 *
 * Rebuilt only when the Swift source changed — `camstack-afm.source-sha256`
 * records the source the binary was built from and `camstack-afm.binary-sha256`
 * the binary that build produced, so an ordinary `npm run build` does not
 * rewrite a committed binary, and `afm-binary.spec.ts` fails when EITHER moved
 * without a rebuild (a hand-copied binary included).
 *
 * darwin + SDK >= 26 only. Anywhere else this is a logged no-op (the committed
 * binary is what ships). `--force` rebuilds regardless of the stamp.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_SDK_MAJOR = 26
const DEPLOYMENT_TARGET = 'arm64-apple-macos26.0'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'native', 'afm')
const source = path.join(dir, 'camstack-afm.swift')
const binary = path.join(dir, 'camstack-afm')
const stamp = path.join(dir, 'camstack-afm.source-sha256')
const binaryStamp = path.join(dir, 'camstack-afm.binary-sha256')
const force = process.argv.includes('--force')

const say = (msg) => process.stdout.write(`[build-afm] ${msg}\n`)

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const readStamp = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '')
const digest = sha256(source)
const binaryCurrent = existsSync(binary) && readStamp(binaryStamp) === sha256(binary)

if (!force && readStamp(stamp) === digest && binaryCurrent) {
  say('binary is current for this source; nothing to do')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  say(`not darwin (${process.platform}); shipping the committed binary unchanged`)
  process.exit(0)
}

let sdkVersion = ''
try {
  sdkVersion = execFileSync('xcrun', ['--show-sdk-version'], { encoding: 'utf8' }).trim()
} catch {
  sdkVersion = ''
}
const sdkMajor = Number.parseInt(sdkVersion.split('.')[0] ?? '', 10)
if (!Number.isFinite(sdkMajor) || sdkMajor < MIN_SDK_MAJOR) {
  const msg = `macOS SDK ${sdkVersion || 'unknown'} < ${String(MIN_SDK_MAJOR)}: cannot build the helper here`
  if (existsSync(binary)) {
    say(
      `${msg}; the committed binary is STALE for this source — rebuild on a Mac with SDK ${String(MIN_SDK_MAJOR)}+`,
    )
    process.exit(0)
  }
  process.stderr.write(`[build-afm] ${msg} and no binary exists\n`)
  process.exit(1)
}

say(`compiling with SDK ${sdkVersion} for ${DEPLOYMENT_TARGET}`)
execFileSync(
  'xcrun',
  ['swiftc', '-O', '-swift-version', '5', '-target', DEPLOYMENT_TARGET, '-o', binary, source],
  { stdio: 'inherit' },
)
writeFileSync(stamp, `${digest}\n`)
writeFileSync(binaryStamp, `${sha256(binary)}\n`)
say(`built ${path.relative(root, binary)} (source ${digest.slice(0, 12)})`)
