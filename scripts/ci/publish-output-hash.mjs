/**
 * Content hash of a package tarball, with the stamps a rebuild always
 * changes taken out: the package's own version, every `@camstack/*`
 * version it records, absolute build paths, the content hash vite puts
 * in a filename when those bytes change, and a bare
 * `import "@module-federation/runtime"` the share config already marks
 * host-provided.
 *
 * Two builds of one tree must hash equal. A build that only picked up a
 * library the bundle does not use must hash equal to the tarball already
 * on the registry — that is the whole publish decision.
 */

import { createHash } from 'node:crypto'
import * as path from 'node:path'

export const VERSION_PLACEHOLDER = '0.0.0'

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.map',
  '.txt',
  '.md',
  '.svg',
  '.xml',
])

/** `index-DKs9f3a1.js` or `file-CIorc-ds.mjs` — vite's content hash, not a word. */
const CONTENT_HASH =
  /-([A-Za-z0-9_-]{8,12})(\.(?:js|mjs|cjs|css|map|html|svg|png|jpe?g|woff2?))(?=["'\s)\];,]|\.map|$)/g

/**
 * A vite/rollup content hash is mixed-case or contains a digit. A lowercase
 * word (`loadShare`, `overlays`) is part of the filename. Hashes with no
 * digit (`CIorc-ds`, `CsmoBUiq`) still count — requiring a digit left the
 * registry name intact and the local name rewritten, so the same chunk
 * looked like two files.
 */
function looksLikeContentHash(hash) {
  if (hash.length < 8 || hash.length > 12) return false
  return /[A-Z]/.test(hash) || /[0-9]/.test(hash)
}

/**
 * An absolute path that lands in a workspace tree
 * (`/home/runner/work/server/server/packages/...`, or the same on a laptop).
 * A `../` segment is not an absolute path — rollup's `#region` comments use
 * those, and their depth depends on where the checkout sits.
 */
const ABSOLUTE_WORKSPACE =
  /(?<![.\w])(?:file:\/\/)?(?:\/(?!\.\.)[\w.+@-]+)+\/(?=(?:packages|server)\/)/g

/**
 * `//#region ../../packages/types/dist/foo.mjs` and
 * `//#region ../types/dist/foo.mjs` are the same module. The number of `../`
 * is the checkout's depth (a worktree is deeper than the GitHub runner).
 * The same depth shows up in tsup's `// ../../node_modules/...` comments and
 * in source-map `sources`, not only in `#region`.
 */
export function normaliseBuildPaths(text) {
  const regions = text.replace(/\/\/#region\s+(\S+)/g, (_full, spec) => {
    const suffix = spec.replace(/^(?:\.\.\/)+/, '').replace(/^(?:packages|server)\//, '')
    return `//#region ${suffix}`
  })
  return regions.replace(/(?:\.\.\/)+(?=(?:node_modules|packages|server)\/)/g, '')
}

function isTextPath(rel) {
  if (rel.endsWith('.viewer-version')) return true
  return TEXT_EXTENSIONS.has(path.posix.extname(rel))
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const body = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')
  return `{${body}}`
}

function starCamstackDeps(section) {
  const next = {}
  for (const [name, spec] of Object.entries(section)) {
    next[name] = name.startsWith('@camstack/') ? '*' : spec
  }
  return next
}

/** Top-level version and `@camstack/*` specs. Nested manifest versions stay. */
export function normalisePackageJsonText(text) {
  const parsed = JSON.parse(text)
  const next = { ...parsed, version: VERSION_PLACEHOLDER }
  for (const section of DEP_SECTIONS) {
    if (parsed[section] !== undefined) next[section] = starCamstackDeps(parsed[section])
  }
  return stableStringify(next)
}

export function embeddedCamstackVersions(files) {
  const found = []
  const patterns = [
    /@camstack\/[a-z0-9-]+[^@]{0,240}?version:\s*["'](\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)["']/g,
    /version:\s*["'](\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)["'][^@]{0,240}?@camstack\/[a-z0-9-]+/g,
  ]
  for (const file of files) {
    if (!isTextPath(file.path)) continue
    const text = file.bytes.toString('utf8')
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) found.push(match[1])
    }
  }
  return found
}

export function mergeStamps(groups) {
  return [...new Set(groups.flat().filter((stamp) => stamp && stamp !== VERSION_PLACEHOLDER))].sort(
    (a, b) => b.length - a.length,
  )
}
export function versionStampsFromPackageJson(packageJson) {
  const stamps = []
  if (typeof packageJson.version === 'string' && packageJson.version !== VERSION_PLACEHOLDER) {
    stamps.push(packageJson.version)
  }
  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(packageJson[section] ?? {})) {
      if (!name.startsWith('@camstack/') || typeof spec !== 'string' || spec === '*') continue
      const bare = spec.replace(/^[\^~>=< ]+/, '')
      if (/^\d+\.\d+\.\d+/.test(bare)) stamps.push(bare)
    }
  }
  return [...new Set(stamps)].sort((a, b) => b.length - a.length)
}

export function replaceStamps(text, stamps) {
  let out = text
  for (const stamp of stamps) {
    if (stamp.length === 0 || stamp === VERSION_PLACEHOLDER) continue
    out = out.split(stamp).join(VERSION_PLACEHOLDER)
  }
  return out
}

export function stripAbsolutePaths(text, roots) {
  let out = text
  const ordered = [...roots].filter((root) => root.length > 1).sort((a, b) => b.length - a.length)
  for (const root of ordered) {
    out = out.split(root).join('<root>')
    out = out.split(`file://${root}`).join('file://<root>')
  }
  return out.replace(ABSOLUTE_WORKSPACE, '<root>/')
}

export function stripContentHashes(text) {
  return text.replace(CONTENT_HASH, (full, hash, ext) => {
    if (!looksLikeContentHash(hash)) return full
    return `-[hash]${ext}`
  })
}

/**
 * `shared: { '@module-federation/runtime': { import: false } }` means the
 * host provides the runtime. The page stub must not keep a bare import: the
 * browser has no import map for it (addon-model-studio's vite config).
 * Rolldown still emits that one statement from a worktree whose
 * `node_modules` is a symlink, and not from the GitHub runner that built
 * the registry tarball. The statement is not addon behaviour.
 */
const HOST_RUNTIME_IMPORT = /^[ \t]*import\s+["']@module-federation\/runtime["'];?[ \t]*\r?\n?/gm

export function stripHostProvidedRuntimeImport(text) {
  return text.replace(HOST_RUNTIME_IMPORT, '')
}

export function normaliseRelPath(rel) {
  const posix = rel.replace(/\\/g, '/')
  const dir = path.posix.dirname(posix)
  const base = stripContentHashes(path.posix.basename(posix))
  return dir === '.' ? base : `${dir}/${base}`
}

function normaliseBytes(rel, bytes, stamps, roots) {
  if (!isTextPath(rel)) return bytes
  const text = bytes.toString('utf8')
  if (rel === 'package.json' || rel.endsWith('/package.json')) {
    return Buffer.from(normalisePackageJsonText(text))
  }
  const stamped = replaceStamps(text, stamps)
  const rooted = stripAbsolutePaths(stamped, roots)
  const pathed = stripHostProvidedRuntimeImport(normaliseBuildPaths(rooted))
  return Buffer.from(stripContentHashes(pathed))
}

/**
 * Canonical file list: normalised paths, normalised bytes, duplicates
 * distinguished so two chunks that hash to the same filename both count.
 */
export function normaliseFileSet(files, stamps, roots) {
  const mapped = files.map((file) => ({
    path: normaliseRelPath(file.path),
    bytes: normaliseBytes(file.path, file.bytes, stamps, roots),
  }))
  mapped.sort((a, b) => a.path.localeCompare(b.path) || Buffer.compare(a.bytes, b.bytes))
  const seen = new Map()
  return mapped.map((file) => {
    const count = seen.get(file.path) ?? 0
    seen.set(file.path, count + 1)
    if (count === 0) return file
    return { path: `${file.path}#${count}`, bytes: file.bytes }
  })
}

export function contentHash(files, options) {
  const stamps = options.stamps ?? []
  const roots = options.roots ?? []
  const normalised = normaliseFileSet(files, stamps, roots)
  const hash = createHash('sha256')
  for (const file of normalised) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return { digest: hash.digest('hex'), files: normalised }
}

export function differingPaths(leftFiles, rightFiles) {
  const left = new Map(leftFiles.map((file) => [file.path, file.bytes]))
  const right = new Map(rightFiles.map((file) => [file.path, file.bytes]))
  const paths = new Set([...left.keys(), ...right.keys()])
  const differing = []
  for (const rel of [...paths].sort()) {
    const a = left.get(rel)
    const b = right.get(rel)
    if (a === undefined || b === undefined || !a.equals(b)) differing.push(rel)
  }
  return differing
}

/** `diffCount === 0` → the candidate publishes nothing new. */
export function candidateReason(diffCount) {
  return diffCount === 0 ? 'bundle unchanged' : `dist differs: ${diffCount} files`
}

export function compareNormalised(localFiles, publishedFiles, stamps, roots = []) {
  const local = contentHash(localFiles, { stamps, roots })
  const published = contentHash(publishedFiles, { stamps, roots })
  const differing = differingPaths(local.files, published.files)
  return {
    equal: differing.length === 0,
    differing,
    reason: candidateReason(differing.length),
    local,
    published,
  }
}
