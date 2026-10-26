#!/usr/bin/env node
/**
 * publish-output — drop bundle-cascade candidates whose built tarball
 * matches the one already on the registry.
 *
 * The cascade in publish-scope.mjs still SELECTS them (a bundler holds a
 * copy, and a copy that changed must ship — D545). This asks the artifact,
 * after the build and before publish. Only candidates are packed and
 * compared. A direct change, a forced package, an nx dependent, and the
 * server closure are not asked.
 *
 *   node scripts/ci/publish-output.mjs --from-env
 *   node scripts/ci/publish-output.mjs --base <ref> [--head <ref>] [--force name,name]
 *
 * `--from-env` reads PUBLISH_KEEP, PUBLISH_CANDIDATES,
 * PUBLISH_SERVER_FROM_CLOSURE, optional PUBLISH_EFFECTIVE (the viewer gate's
 * narrowed set) and PUBLISH_REVERT_DROPPED. It writes `packages` and
 * `dropped` to GITHUB_OUTPUT when that variable is set.
 *
 * `--base` is the local dry run: diff `base..head` (lockfile excluded),
 * partition, and compare each candidate to the version that ref published.
 * It does not bump, revert, or publish.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  directOwners,
  finalizePublishSet,
  partitionPublishSet,
  readWorkspace,
} from './publish-scope.mjs'
import {
  compareNormalised,
  embeddedCamstackVersions,
  mergeStamps,
  versionStampsFromPackageJson,
} from './publish-output-hash.mjs'

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end < start) {
    throw new Error(`npm pack did not return JSON: ${stdout.slice(0, 400)}`)
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1))
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (entry?.files === undefined) throw new Error('npm pack JSON has no file list')
  return entry
}

export function readLocalPackFiles(dir) {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const info = parseNpmPackJson(stdout)
  return info.files.map((file) => {
    const rel = String(file.path).replace(/^package\//, '')
    return { path: rel, bytes: fs.readFileSync(path.join(dir, rel)) }
  })
}

function readRegistryPackFiles(name, version) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-output-'))
  let stdout
  try {
    stdout = execFileSync(
      'npm',
      ['pack', `${name}@${version}`, '--json', '--ignore-scripts', '--pack-destination', dest],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `npm pack ${name}@${version} failed — refusing to drop the candidate. ${detail}`,
    )
  }
  const info = parseNpmPackJson(stdout)
  const extract = path.join(dest, 'extract')
  fs.mkdirSync(extract)
  execFileSync('tar', ['-xzf', path.join(dest, info.filename), '-C', extract])
  return info.files.map((file) => {
    const rel = String(file.path).replace(/^package\//, '')
    // npm pack --json lists paths inside the package. The tarball wraps
    // them in a `package/` directory.
    return { path: rel, bytes: fs.readFileSync(path.join(extract, 'package', rel)) }
  })
}

function packageJsonFrom(files) {
  const file = files.find((entry) => entry.path === 'package.json')
  if (file === undefined) throw new Error('tarball has no package.json')
  return JSON.parse(file.bytes.toString('utf8'))
}

/**
 * Compare one built package to a registry tarball. Missing `dist/` is a
 * hard error: an empty pack would look "different" and publish, or look
 * "equal" and drop, and neither is a measurement.
 */
export function compareBuiltPackage(dir, registryVersion, root) {
  const localDir = path.join(root, dir)
  const localFiles = readLocalPackFiles(localDir)
  if (!localFiles.some((file) => file.path.startsWith('dist/'))) {
    throw new Error(`${dir}: npm pack has no dist/ — build the package before comparing`)
  }
  const localPackage = JSON.parse(fs.readFileSync(path.join(localDir, 'package.json'), 'utf8'))
  const publishedFiles = readRegistryPackFiles(localPackage.name, registryVersion)
  const publishedPackage = packageJsonFrom(publishedFiles)
  const workspaceVersions = [...readWorkspace(root).values()].map((pj) => pj.version)
  const stamps = mergeStamps([
    versionStampsFromPackageJson(localPackage),
    versionStampsFromPackageJson(publishedPackage),
    workspaceVersions,
    embeddedCamstackVersions(localFiles),
    embeddedCamstackVersions(publishedFiles),
  ])
  return compareNormalised(localFiles, publishedFiles, stamps, [path.resolve(root)])
}

export function restoreManifest(dir, root) {
  const original = execFileSync('git', ['show', `HEAD:${dir}/package.json`], {
    cwd: root,
    encoding: 'utf8',
  })
  fs.writeFileSync(
    path.join(root, dir, 'package.json'),
    original.endsWith('\n') ? original : `${original}\n`,
  )
}

function restrictPartition(partition, effective) {
  if (effective === null) return partition
  const allow = new Set(effective)
  return {
    ...partition,
    keep: partition.keep.filter((dir) => allow.has(dir)),
    candidates: partition.candidates.filter((dir) => allow.has(dir)),
  }
}

function logDecision(dir, reason) {
  console.log(`publish-output: ${dir} — ${reason}`)
}

function logKeptDirect(partition, publish) {
  const publishing = new Set(publish)
  for (const dir of partition.keep) {
    if (!publishing.has(dir)) continue
    if (partition.serverFromClosure && dir === 'server/backend') continue
    logDecision(dir, 'direct change')
  }
  if (publishing.has('server/backend') && partition.serverFromClosure) {
    logDecision('server/backend', 'closure')
  }
}

/**
 * Hash every candidate. A registry or pack failure throws — dropping a
 * candidate we could not measure is the bug this script exists to avoid.
 */
export function decideCandidates(partition, root, versionOf) {
  const changed = new Set()
  const diffCounts = new Map()
  for (const dir of partition.candidates) {
    const version = versionOf(dir)
    const compared = compareBuiltPackage(dir, version, root)
    diffCounts.set(dir, compared.differing.length)
    logDecision(dir, compared.reason)
    if (!compared.equal) changed.add(dir)
  }
  return { changed, diffCounts }
}

function emitResult(partition, finalized, root, revertDropped) {
  logKeptDirect(partition, finalized.publish)
  if (revertDropped) {
    for (const dir of finalized.dropped) {
      restoreManifest(dir, root)
      console.log(`publish-output: restored ${dir}/package.json (bump reverted)`)
    }
  }
  const packages = finalized.publish.join(',')
  const dropped = finalized.dropped.join(',')
  console.log(`publish-output: final: ${packages.length > 0 ? packages : '(none)'}`)
  const output = process.env.GITHUB_OUTPUT
  if (output !== undefined && output !== '') {
    fs.appendFileSync(output, `packages=${packages}\ndropped=${dropped}\n`)
  }
  return { packages, dropped }
}

function splitCsv(value) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function latestVersion(name) {
  try {
    const version = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' }).trim()
    if (version.length === 0) throw new Error('empty')
    return version
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`npm view ${name} version failed — refusing to drop the candidate. ${detail}`)
  }
}

function runFromEnv(root) {
  const effectiveRaw = process.env.PUBLISH_EFFECTIVE ?? ''
  const partition = restrictPartition(
    {
      keep: splitCsv(process.env.PUBLISH_KEEP),
      candidates: splitCsv(process.env.PUBLISH_CANDIDATES),
      all: [],
      serverFromClosure: process.env.PUBLISH_SERVER_FROM_CLOSURE === 'true',
    },
    effectiveRaw.length > 0 ? splitCsv(effectiveRaw) : null,
  )
  const packages = readWorkspace(root)
  const { changed } = decideCandidates(partition, root, (dir) => {
    const name = packages.get(dir)?.name
    if (name === undefined) throw new Error(`${dir} is not a workspace package`)
    return latestVersion(name)
  })
  const finalized = finalizePublishSet(partition, changed, root)
  const revert = process.env.PUBLISH_REVERT_DROPPED === 'true'
  return emitResult(partition, finalized, root, revert)
}

function versionAtRef(ref, dir, root) {
  const text = execFileSync('git', ['show', `${ref}:${dir}/package.json`], {
    cwd: root,
    encoding: 'utf8',
  })
  return JSON.parse(text).version
}

function changedFilesSince(base, head, root) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', base, head, '--', '.', ':(exclude)package-lock.json'],
    { cwd: root, encoding: 'utf8' },
  )
  return out.split('\n').filter(Boolean)
}

function resolveForced(names, root) {
  const packages = readWorkspace(root)
  const index = new Map()
  for (const [dir, pj] of packages) {
    index.set(pj.name, dir)
    index.set(dir, dir)
    index.set(path.basename(dir), dir)
  }
  const dirs = []
  for (const name of names) {
    const dir = index.get(name)
    if (dir === undefined) throw new Error(`force_packages contains unknown name: ${name}`)
    dirs.push(dir)
  }
  return dirs
}

function runFromGit(root, base, head, force) {
  const files = changedFilesSince(base, head, root)
  const input = [...directOwners(files, root), ...resolveForced(force, root)]
  const partition = partitionPublishSet(input, root)
  console.log(
    `publish-output: base ${base}..${head} — ${partition.candidates.length} bundle candidate(s)`,
  )
  const { changed } = decideCandidates(partition, root, (dir) => versionAtRef(base, dir, root))
  const finalized = finalizePublishSet(partition, changed, root)
  return emitResult(partition, finalized, root, false)
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  return argv[index + 1] ?? null
}

function main() {
  const argv = process.argv.slice(2)
  const root = process.cwd()
  if (argv.includes('--from-env')) {
    runFromEnv(root)
    return
  }
  const base = argValue(argv, '--base')
  if (base !== null) {
    const head = argValue(argv, '--head') ?? 'HEAD'
    const force = splitCsv(argValue(argv, '--force') ?? '')
    runFromGit(root, base, head, force)
    return
  }
  console.error('Usage: publish-output.mjs --from-env | --base <ref> [--head <ref>] [--force a,b]')
  process.exit(1)
}

const invokedDirectly = process.argv[1]?.endsWith('publish-output.mjs') === true
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::error::${message}`)
    process.exit(1)
  }
}
