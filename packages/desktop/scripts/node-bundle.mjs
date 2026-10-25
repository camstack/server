/**
 * The bundled Node runtime: which archive to fetch, how to verify it, how to
 * unpack its ONE useful file. PURE (node:crypto/node:fs/node:path only) so the
 * per-platform choices are unit-testable without a download.
 *
 * Why the runtime is bundled at all: the packaged app runs the node under a
 * real Node, not Electron-as-Node, so Electron's V8 sandbox does not reject
 * native external-memory Buffers (see `stage-deps.mjs`).
 *
 * The three platforms are NOT the same shape:
 *   darwin / linux  `node-vX-<os>-<arch>.tar.gz`  → `<dir>/bin/node`
 *   win             `node-vX-win-<arch>.zip`      → `<dir>/node.exe` (root, no bin/)
 * and the staged layout follows the runtime's own: `bin/node` on POSIX,
 * `node.exe` at the staged root on Windows. `resolveBundledNode`
 * (`process-manager.ts`) looks in exactly those two places.
 *
 * Integrity: nodejs.org publishes `SHASUMS256.txt` beside every release; the
 * archive is verified against it before a byte is extracted. (That file comes
 * from the same host as the archive, so it catches a truncated or swapped
 * download, not a compromised origin — pinning the file's GPG signature is the
 * next step and is not done here.)
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Node's dist directory name for a Node `process.platform`. */
export function nodeDistPlatform(platform) {
  return platform === 'win32' ? 'win' : platform
}

/**
 * Everything the stager needs to know about one Node archive.
 * `binaryRelPath` is where the executable sits INSIDE the archive's top-level
 * dir; `stagedRelPath` is where it lands under the staged runtime dir.
 */
export function nodeArchiveSpec({ platform, arch, version }) {
  const dirName = `node-${version}-${nodeDistPlatform(platform)}-${arch}`
  const windows = platform === 'win32'
  const fileName = `${dirName}.${windows ? 'zip' : 'tar.gz'}`
  return {
    dirName,
    fileName,
    format: windows ? 'zip' : 'tar.gz',
    url: `https://nodejs.org/dist/${version}/${fileName}`,
    shasumsUrl: `https://nodejs.org/dist/${version}/SHASUMS256.txt`,
    binaryRelPath: windows ? 'node.exe' : 'bin/node',
    stagedRelPath: windows ? 'node.exe' : join('bin', 'node'),
  }
}

/**
 * `{ fileName → sha256 }` from the text of a `SHASUMS256.txt`.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseShasums(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())
    if (match) out[match[2]] = match[1].toLowerCase()
  }
  return out
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Refuse an archive that is not the one the release lists. Throws — a staged
 * runtime that is not what nodejs.org published must not ship.
 */
export function verifyNodeArchive(path, fileName, shasumsText) {
  const expected = parseShasums(shasumsText)[fileName]
  if (!expected) {
    throw new Error(`SHASUMS256.txt lists no entry for ${fileName} — refusing to stage it`)
  }
  const actual = sha256File(path)
  if (actual !== expected) {
    throw new Error(
      `${fileName} does not match nodejs.org's SHASUMS256.txt — refusing it. expected=${expected} actual=${actual}`,
    )
  }
}

/**
 * The tar to run to unpack. Windows' own bsdtar (System32) reads a zip; the
 * `tar` first on PATH there may be Git for Windows' GNU tar, which cannot.
 */
export function tarCommand(platform, systemRoot = 'C:\\Windows') {
  return platform === 'win32' ? join(systemRoot, 'System32', 'tar.exe') : 'tar'
}

/** argv for extracting only the executable from the archive into `destDir`. */
export function extractArgs(spec, archivePath, destDir) {
  return [
    spec.format === 'zip' ? '-xf' : '-xzf',
    archivePath,
    '-C',
    destDir,
    '--strip-components=1',
    `${spec.dirName}/${spec.binaryRelPath}`,
  ]
}

/** Windows ships one node-av build per C runtime; official Node.js is MSVC. */
export function nodeAvSiblingName(platform, arch) {
  return platform === 'win32'
    ? `@seydx/node-av-win32-${arch}-msvc`
    : `@seydx/node-av-${platform}-${arch}`
}
