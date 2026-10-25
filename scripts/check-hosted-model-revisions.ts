#!/usr/bin/env tsx
/**
 * Hosted-revision guard — every artefact on the CamStack model mirror has a
 * revision, and that revision is the sha256 the mirror holds for its weight
 * file (D743, D744).
 *
 * ## The failure this catches
 *
 * A node keeps any model file it already has. The YOLO26 @320/@256 CoreML
 * packages were replaced in place on the mirror to stop a crash-on-load
 * (D742) and the YOLOv9 ones to reach the Neural Engine (D743); a node holding
 * the old bytes would have kept them forever, and nothing said so. The
 * revision makes such a copy stale, but only if it CHANGES when the bytes do —
 * a hand-kept revision is forgotten exactly when it matters.
 *
 * ## What it checks
 *
 * Offline (always):
 * 1. Every built-in catalog format hosted on the mirror has an entry in
 *    `packages/system/src/download/hosted-model-revisions.ts`, and no entry is
 *    left without a format.
 * 2. No hosted format sets an inline `revision` — the generated table is the
 *    one source for the mirror.
 *
 * Online (the mirror's tree API, read-only, no token):
 * 3. Every revision equals the `lfs.oid` (the sha256) of the format's weight
 *    file on the mirror — `revisionWeightUrl` decides which file that is.
 *
 * Not wired into automatic CI: it needs the network. When the mirror cannot be
 * reached it says so and checks only 1–2 (exit 0), unless `--require-network`.
 *
 * Usage:
 *   tsx scripts/check-hosted-model-revisions.ts             # check
 *   tsx scripts/check-hosted-model-revisions.ts --offline   # 1–2 only
 *   tsx scripts/check-hosted-model-revisions.ts --write     # regenerate the table from the mirror
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { ModelFormatEntry } from '../packages/types/src/types/models.js'
import { HOSTED_MODEL_REVISIONS } from '../packages/system/src/download/hosted-model-revisions.js'
import {
  HOSTED_MODEL_MIRROR_PREFIX,
  revisionWeightUrl,
} from '../packages/system/src/download/model-downloader.js'
import { builtInCatalogEntries } from './lib/model-catalogs.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const TABLE_FILE = path.join(ROOT, 'packages/system/src/download/hosted-model-revisions.ts')
const MIRROR_REPO = 'camstack/camstack-models'
const TREE_URL = `https://huggingface.co/api/models/${MIRROR_REPO}/tree/main?recursive=true`
const FETCH_TIMEOUT_MS = 30_000

interface HostedFormat {
  readonly key: string
  readonly owner: string
  readonly format: ModelFormatEntry
}

interface MirrorFile {
  readonly path: string
  readonly lfsOid: string | null
}

function hostedFormats(): readonly HostedFormat[] {
  const byKey = new Map<string, HostedFormat>()
  for (const { source, entry } of builtInCatalogEntries()) {
    for (const [name, format] of Object.entries(entry.formats)) {
      if (format === undefined || !format.url.startsWith(HOSTED_MODEL_MIRROR_PREFIX)) continue
      const key = format.url.slice(HOSTED_MODEL_MIRROR_PREFIX.length)
      if (!byKey.has(key)) byKey.set(key, { key, owner: `${source}:${entry.id}/${name}`, format })
    }
  }
  return [...byKey.values()].toSorted((a, b) => a.key.localeCompare(b.key))
}

function asMirrorFiles(page: unknown): readonly MirrorFile[] {
  if (!Array.isArray(page)) throw new Error('the mirror tree API did not answer a list')
  const files: MirrorFile[] = []
  for (const item of page) {
    if (typeof item !== 'object' || item === null) continue
    if (!('type' in item) || item.type !== 'file') continue
    if (!('path' in item) || typeof item.path !== 'string') continue
    const lfs = 'lfs' in item && typeof item.lfs === 'object' && item.lfs !== null ? item.lfs : null
    const oid = lfs !== null && 'oid' in lfs && typeof lfs.oid === 'string' ? lfs.oid : null
    files.push({ path: item.path, lfsOid: oid })
  }
  return files
}

/** The whole mirror tree, following the API's cursor pagination. */
async function fetchMirror(): Promise<ReadonlyMap<string, MirrorFile>> {
  const files = new Map<string, MirrorFile>()
  let next: string | null = TREE_URL
  while (next !== null) {
    const res = await fetch(next, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${String(res.status)} from ${next}`)
    for (const f of asMirrorFiles(await res.json())) files.set(f.path, f)
    const link = res.headers.get('link') ?? ''
    next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null
  }
  return files
}

/** The revision the mirror holds for a format, or why it has none. */
function mirrorRevision(
  hosted: HostedFormat,
  mirror: ReadonlyMap<string, MirrorFile>,
): { readonly revision: string } | { readonly problem: string } {
  const weightUrl = revisionWeightUrl(hosted.format)
  if (weightUrl === null) return { problem: 'has no weight file to take a revision from' }
  const weightPath = weightUrl.slice(HOSTED_MODEL_MIRROR_PREFIX.length)
  const file = mirror.get(weightPath)
  if (file === undefined) return { problem: `weight file ${weightPath} is not on the mirror` }
  if (file.lfsOid === null) return { problem: `weight file ${weightPath} is not an LFS file` }
  return { revision: file.lfsOid }
}

function offlineProblems(formats: readonly HostedFormat[]): readonly string[] {
  const problems: string[] = []
  const keys = new Set(formats.map((f) => f.key))
  for (const f of formats) {
    if (HOSTED_MODEL_REVISIONS[f.key] === undefined) {
      problems.push(`${f.owner}: ${f.key} has no revision in the table — run --write`)
    }
    if (f.format.revision !== undefined) {
      problems.push(`${f.owner}: sets an inline revision; the generated table is the one source`)
    }
  }
  for (const key of Object.keys(HOSTED_MODEL_REVISIONS)) {
    if (!keys.has(key)) problems.push(`table entry ${key} has no catalog format — run --write`)
  }
  return problems
}

function onlineProblems(
  formats: readonly HostedFormat[],
  mirror: ReadonlyMap<string, MirrorFile>,
): readonly string[] {
  const problems: string[] = []
  for (const f of formats) {
    const found = mirrorRevision(f, mirror)
    if ('problem' in found) {
      problems.push(`${f.owner}: ${found.problem}`)
      continue
    }
    const recorded = HOSTED_MODEL_REVISIONS[f.key]
    if (recorded !== undefined && recorded !== found.revision) {
      problems.push(
        `${f.owner}: the mirror replaced ${f.key} (table ${recorded.slice(0, 12)}…, mirror ${found.revision.slice(0, 12)}…) — run --write`,
      )
    }
  }
  return problems
}

function renderTable(revisions: ReadonlyMap<string, string>): string {
  const lines = [...revisions.entries()].map(([key, rev]) => `  '${key}': '${rev}',`)
  return `/**
 * GENERATED by \`scripts/check-hosted-model-revisions.ts --write\` — DO NOT EDIT.
 *
 * The revision of every artefact on the CamStack model mirror, keyed by its
 * path under \`${HOSTED_MODEL_MIRROR_PREFIX}\`: the sha256 (\`lfs.oid\`)
 * of its weight file (\`revisionWeightUrl\`). \`resolveFormatRevision\` reads
 * it for every catalog format hosted there (D743, D744). Regenerate after
 * any upload to the mirror; the script without \`--write\` says when it is due.
 */
export const HOSTED_MODEL_REVISIONS: Readonly<Record<string, string>> = {
${lines.join('\n')}
}
`
}

async function write(formats: readonly HostedFormat[]): Promise<number> {
  const mirror = await fetchMirror()
  const revisions = new Map<string, string>()
  const problems: string[] = []
  for (const f of formats) {
    const found = mirrorRevision(f, mirror)
    if ('problem' in found) problems.push(`${f.owner}: ${found.problem}`)
    else revisions.set(f.key, found.revision)
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ✗ ${p}`)
    console.error('hosted-model-revisions: table NOT written')
    return 1
  }
  writeFileSync(TABLE_FILE, renderTable(revisions))
  execFileSync('npx', ['biome', 'format', '--write', TABLE_FILE], { cwd: ROOT, stdio: 'ignore' })
  console.log(`hosted-model-revisions: wrote ${String(revisions.size)} revisions`)
  return 0
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2))
  const formats = hostedFormats()
  if (args.has('--write')) return write(formats)

  const problems = [...offlineProblems(formats)]
  if (!args.has('--offline')) {
    try {
      problems.push(...onlineProblems(formats, await fetchMirror()))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (args.has('--require-network')) {
        console.error(`hosted-model-revisions: the mirror is unreachable (${reason})`)
        return 1
      }
      console.warn(`hosted-model-revisions: mirror unreachable (${reason}) — offline checks only`)
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ✗ ${p}`)
    console.error(`hosted-model-revisions: ${String(problems.length)} problem(s)`)
    return 1
  }
  console.log(`hosted-model-revisions: ${String(formats.length)} hosted formats OK`)
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(err)
    process.exitCode = 1
  },
)
