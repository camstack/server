import * as fs from 'node:fs'
import * as path from 'node:path'
import { CORE_EXAMPLES } from './catalogue.js'
import type { ExampleEntry, ExampleHit } from '../types.js'

export function listExamples(): readonly ExampleEntry[] {
  return CORE_EXAMPLES
}

/**
 * Rank curated examples against a free-text query (kind, tags, package path).
 */
export function findExample(workspaceRoot: string, query: string): readonly ExampleHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return CORE_EXAMPLES.map((example) => ({
      example,
      score: 0,
      rationale: 'No query — listing curated catalogue.',
    }))
  }

  const hits: ExampleHit[] = []
  for (const example of CORE_EXAMPLES) {
    const { score, rationale } = scoreExample(example, tokens, workspaceRoot)
    if (score > 0) hits.push({ example, score, rationale })
  }
  return hits.toSorted((a, b) => b.score - a.score || a.example.id.localeCompare(b.example.id))
}

function tokenize(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

function scoreExample(
  example: ExampleEntry,
  tokens: readonly string[],
  workspaceRoot: string,
): { score: number; rationale: string } {
  let score = 0
  const reasons: string[] = []
  const haystack = [
    example.id,
    example.kind,
    example.packageDir,
    example.demonstrates,
    ...example.tags,
  ]
    .join(' ')
    .toLowerCase()

  for (const token of tokens) {
    if (example.kind === token) {
      score += 5
      reasons.push(`kind=${token}`)
    } else if (example.tags.includes(token)) {
      score += 4
      reasons.push(`tag=${token}`)
    } else if (example.id.includes(token) || example.packageDir.includes(token)) {
      score += 3
      reasons.push(`path~${token}`)
    } else if (haystack.includes(token)) {
      score += 1
      reasons.push(`text~${token}`)
    }
  }

  const abs = path.join(workspaceRoot, example.packageDir)
  if (!fs.existsSync(abs)) {
    score = Math.max(0, score - 2)
    reasons.push('package missing in this checkout')
  }

  return {
    score,
    rationale: reasons.length > 0 ? reasons.join('; ') : 'weak match',
  }
}
