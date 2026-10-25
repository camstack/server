import * as fs from 'node:fs'
import * as path from 'node:path'
import { headingSlug, splitByHeading } from './headings.js'
import type { KnowledgeIndex } from './index.js'
import type { KnowledgeDoc, KnowledgeSource } from './types.js'

/** A section read stops here and says the rest is still in the file. */
export const SECTION_READ_LIMIT: number = 12 * 1024

export interface SectionRead {
  readonly id: string
  readonly kind: KnowledgeDoc['kind']
  readonly relativePath: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  /** Set when the section was read from the sibling planning clone. */
  readonly source?: KnowledgeSource
}

export interface NextAdrNumber {
  readonly next: number
  readonly id: string
  readonly filePattern: string
}

const ADR_FILE_NAME = /^adr-(\d+)/i

export function readSection(index: KnowledgeIndex, id: string): SectionRead | null {
  const doc = index.getById(id)
  if (!doc) return null
  const full = fullSectionText(doc)
  const bounded = boundSection(full, doc.relativePath)
  return {
    id: doc.id,
    kind: doc.kind,
    relativePath: doc.relativePath,
    title: doc.title,
    text: bounded.text,
    truncated: bounded.truncated,
    ...(doc.source ? { source: doc.source } : {}),
  }
}

/**
 * Next free ADR number from the decision files on disk. `index.md` is
 * generated and lags concurrent branches, so it is not a source.
 */
export function nextAdrNumber(decisionsDir: string): NextAdrNumber {
  let max = 0
  let names: string[] = []
  try {
    names = fs.readdirSync(decisionsDir)
  } catch {
    names = []
  }
  for (const name of names) {
    const match = ADR_FILE_NAME.exec(name)
    if (!match) continue
    const n = Number(match[1])
    if (Number.isInteger(n) && n > max) max = n
  }
  const next = max + 1
  const padded = String(next).padStart(4, '0')
  return {
    next,
    id: `D${next}`,
    filePattern: `docs/decisions/adr-${padded}-<slug>.md`,
  }
}

function fullSectionText(doc: KnowledgeDoc): string {
  if (doc.kind === 'architecture') return architectureSection(doc)
  if (doc.kind === 'guard' || doc.kind === 'subsystem') return doc.body
  return readFile(doc.path) ?? doc.body
}

function architectureSection(doc: KnowledgeDoc): string {
  const file = readFile(doc.path)
  if (!file) return doc.body
  const name = path.basename(doc.path).replace(/\.md$/, '')
  let chosen: { heading: string; body: string } | undefined
  for (const chunk of splitByHeading(file)) {
    const id = `arch:${name}${chunk.heading ? `#${headingSlug(chunk.heading)}` : ''}`
    if (id === doc.id) chosen = chunk
  }
  if (!chosen) return doc.body
  const headingLine = chosen.heading.length > 0 ? `# ${chosen.heading}\n` : ''
  return `${headingLine}${chosen.body}`
}

function boundSection(text: string, relativePath: string): { text: string; truncated: boolean } {
  if (text.length <= SECTION_READ_LIMIT) return { text, truncated: false }
  const shown = text.slice(0, SECTION_READ_LIMIT)
  const note =
    `\n\n[truncated at ${SECTION_READ_LIMIT} bytes — section continues in ` +
    `${relativePath}; showing ${SECTION_READ_LIMIT} of ${text.length}]`
  return { text: shown + note, truncated: true }
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}
