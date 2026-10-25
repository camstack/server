/**
 * Optional private overlay: ~/.camstack/develop.json
 *
 * {
 *   "memoryRoots": ["/path/to/claude/projects/.../memory"],
 *   "skillRoots": ["/Users/me/.claude/skills"]
 * }
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface DevelopOverlay {
  readonly memoryRoots: readonly string[]
  readonly skillRoots: readonly string[]
}

const EMPTY: DevelopOverlay = { memoryRoots: [], skillRoots: [] }

export function loadDevelopOverlay(home: string = os.homedir()): DevelopOverlay {
  const file = path.join(home, '.camstack', 'develop.json')
  if (!fs.existsSync(file)) {
    // Sensible defaults for the operator machine — never required.
    const defaults: string[] = []
    const claudeProjects = path.join(home, '.claude', 'projects')
    if (fs.existsSync(claudeProjects)) {
      // Pick memory dirs that look like camstack-server project memory.
      try {
        for (const entry of fs.readdirSync(claudeProjects, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const mem = path.join(claudeProjects, entry.name, 'memory')
          if (fs.existsSync(mem) && /camstack/i.test(entry.name)) defaults.push(mem)
        }
      } catch {
        /* ignore */
      }
    }
    const userSkills = path.join(home, '.claude', 'skills')
    return {
      memoryRoots: defaults,
      skillRoots: fs.existsSync(userSkills) ? [userSkills] : [],
    }
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return EMPTY
    return {
      memoryRoots: asStringArray('memoryRoots' in raw ? raw.memoryRoots : undefined),
      skillRoots: asStringArray('skillRoots' in raw ? raw.skillRoots : undefined),
    }
  } catch {
    return EMPTY
  }
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}
