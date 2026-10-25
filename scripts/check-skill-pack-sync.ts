#!/usr/bin/env tsx
/**
 * The public skill pack and the repository skills do not say the same thing twice.
 *
 * `packages/develop/skills/<id>.md` is the canonical PUBLIC text of a skill: it
 * ships on npm with `@camstack/develop` and is what `camstack develop skill`
 * and the `@camstack/mcp-develop` server hand to a third-party author. The
 * repository skill `.claude/skills/<id>/SKILL.md` is an OVERLAY on it: it
 * points at the pack text and keeps only what is true of this repository.
 *
 * ## The failure this catches
 *
 * The pack began as a sanitized copy of the repo skills. Two copies of one
 * procedure drift: by 2026-10-09 the repo `camstack-addon` was 358 lines and
 * the pack's 126, and the pack still told authors to deploy the wrong package
 * after a cap change. Nobody reads both; whichever an agent loaded, it was
 * partly wrong. The cure is one text per fact, so this guard fails when:
 *
 *   - a pack skill has a repo skill and that skill does not point at the pack
 *     file (`packages/develop/skills/<id>.md`);
 *   - the two share a section heading (the same section written twice);
 *   - the names differ (`name:` must be the skill id in both);
 *   - the pack links outside itself (`](../…)` breaks once published);
 *   - a pack file is missing from the pack README table.
 *
 * A pack skill with no repo skill (`architecture`) is public-only and fine.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACK_DIR = 'packages/develop/skills'
const REPO_DIR = '.claude/skills'

export interface SkillFile {
  readonly id: string
  readonly text: string
}

/** `## 3. Hand-edits — then codegen` → `hand-edits`: the part a reader matches on. */
export function normalizeHeading(raw: string): string {
  return raw
    .replace(/^#{2,3}\s+/, '')
    .replace(/^\d+\.\s*/, '')
    .split(' — ')[0]
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
}

export function headingsOf(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
  let inFence = false
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    if (!inFence && /^#{2,3}\s+\S/.test(line)) out.push(normalizeHeading(line))
  }
  return out
}

function frontmatterName(text: string): string | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  const name = m ? /^name:\s*(.+)$/m.exec(m[1]) : null
  return name ? name[1].trim() : null
}

export function packSyncProblems(
  packs: readonly SkillFile[],
  overlays: readonly SkillFile[],
  packReadme: string,
): string[] {
  const problems: string[] = []
  const overlayById = new Map(overlays.map((o) => [o.id, o]))
  for (const pack of packs) {
    const packFile = `${PACK_DIR}/${pack.id}.md`
    if (!packReadme.includes(`./${pack.id}.md`)) {
      problems.push(`${packFile}: not listed in ${PACK_DIR}/README.md`)
    }
    if (frontmatterName(pack.text) !== pack.id) {
      problems.push(`${packFile}: frontmatter name must be "${pack.id}"`)
    }
    if (/\]\(\.\.\//.test(pack.text)) {
      problems.push(`${packFile}: links outside the pack (\`](../…)\`) — it breaks once published`)
    }
    const overlay = overlayById.get(pack.id)
    if (!overlay) continue
    const overlayFile = `${REPO_DIR}/${pack.id}/SKILL.md`
    if (frontmatterName(overlay.text) !== pack.id) {
      problems.push(`${overlayFile}: frontmatter name must be "${pack.id}"`)
    }
    if (!overlay.text.includes(packFile)) {
      problems.push(`${overlayFile}: must point at its canonical public text \`${packFile}\``)
    }
    const inPack = new Set(headingsOf(pack.text))
    for (const h of headingsOf(overlay.text)) {
      if (inPack.has(h)) {
        problems.push(
          `${overlayFile}: section "${h}" is also in ${packFile} — the same section written twice drifts; keep it in one`,
        )
      }
    }
  }
  return problems
}

function readSkills(): { packs: SkillFile[]; overlays: SkillFile[]; packReadme: string } {
  const packDir = path.join(ROOT, PACK_DIR)
  const packs = fs
    .readdirSync(packDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .toSorted()
    .map((f) => ({
      id: f.replace(/\.md$/, ''),
      text: fs.readFileSync(path.join(packDir, f), 'utf8'),
    }))
  const repoDir = path.join(ROOT, REPO_DIR)
  const overlays = fs
    .readdirSync(repoDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(repoDir, d.name, 'SKILL.md')))
    .map((d) => ({
      id: d.name,
      text: fs.readFileSync(path.join(repoDir, d.name, 'SKILL.md'), 'utf8'),
    }))
  return { packs, overlays, packReadme: fs.readFileSync(path.join(packDir, 'README.md'), 'utf8') }
}

function main(): void {
  const { packs, overlays, packReadme } = readSkills()
  const problems = packSyncProblems(packs, overlays, packReadme)
  if (problems.length > 0) {
    console.error('✘ check-skill-pack-sync: the public pack and the repo skills disagree')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  const shared = packs.filter((p) => overlays.some((o) => o.id === p.id)).length
  console.log(
    `✔ check-skill-pack-sync: ${packs.length} pack skills, ${shared} with a repo overlay, no section written twice`,
  )
}

if (import.meta.filename === process.argv[1]) main()
