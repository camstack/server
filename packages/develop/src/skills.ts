import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillInfo } from './types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function resolveSkillsDir(): string {
  const candidates = [path.resolve(HERE, '..', 'skills'), path.resolve(HERE, '..', '..', 'skills')]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return candidates[0]!
}

const SKILL_FILES: readonly { id: string; file: string; title: string }[] = [
  { id: 'camstack-addon', file: 'camstack-addon.md', title: 'Add or extend an addon' },
  {
    id: 'camstack-capability',
    file: 'camstack-capability.md',
    title: 'Add or change a capability',
  },
  { id: 'camstack-secrets', file: 'camstack-secrets.md', title: 'Secrets in an addon' },
  { id: 'camstack-docs', file: 'camstack-docs.md', title: 'Keep documentation true' },
  {
    id: 'architecture',
    file: 'architecture.md',
    title: 'Architecture pointers for plugin authors',
  },
  {
    id: 'track-review',
    file: 'track-review.md',
    title: 'Review wrong-class tracks and curate the re-training set',
  },
]

/**
 * The ids before the 2026-10-09 rename to the server repository's skill names.
 * Still accepted by `readSkill`, so a pinned agent prompt keeps working.
 */
const SKILL_ALIASES: Readonly<Record<string, string>> = {
  'add-addon': 'camstack-addon',
  'add-capability': 'camstack-capability',
  'sync-docs': 'camstack-docs',
}

export function listSkills(): readonly SkillInfo[] {
  const dir = resolveSkillsDir()
  return SKILL_FILES.map((s) => ({
    id: s.id,
    title: s.title,
    absolutePath: path.join(dir, s.file),
    relativePath: path.join('skills', s.file),
  }))
}

export function readSkill(id: string): { info: SkillInfo; content: string } | null {
  const canonical = SKILL_ALIASES[id] ?? id
  const info = listSkills().find((s) => s.id === canonical)
  if (!info) return null
  if (!fs.existsSync(info.absolutePath)) return null
  return { info, content: fs.readFileSync(info.absolutePath, 'utf8') }
}
