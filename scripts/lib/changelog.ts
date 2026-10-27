/**
 * Keep a Changelog text operations, shared by `changelog:add`, the release
 * step of the Publish Packages workflow and the unreleased-entries guard.
 *
 * Everything here is a pure function on the file's text: callers read and
 * write the file. The format is the one every package CHANGELOG.md already
 * uses: a `# Changelog` title, then `## [Unreleased]`, then one
 * `## [<version>] - <date>` block per release, each holding `### <Type>`
 * sections of `- ` bullets.
 */

export const CHANGE_TYPES = ['added', 'changed', 'removed', 'fixed'] as const
export type ChangeType = (typeof CHANGE_TYPES)[number]

export const REBUILT_LINE = 'Rebuilt against updated dependencies.'

const HEADER = [
  '# Changelog',
  '',
  'All notable changes to this package are documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
  'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
].join('\n')

/** The placeholder the first generation of stubs carried. It is not an entry. */
const STUB_PATTERN = /^-\s+Package README and changelog\b/

const UNRELEASED_HEADING = '## [Unreleased]'

export interface ParsedChangelog {
  /** Everything before `## [Unreleased]` (the title and preamble). */
  readonly head: string
  /** Bullets under `[Unreleased]`, per section title as written (`Added`). */
  readonly unreleased: ReadonlyMap<string, readonly string[]>
  /** Everything after the Unreleased block: released versions. */
  readonly rest: string
}

export function isChangeType(value: string): value is ChangeType {
  return CHANGE_TYPES.some((type) => type === value)
}

function titleOf(type: ChangeType): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}

function sectionRank(title: string): number {
  const index = CHANGE_TYPES.findIndex((type) => titleOf(type) === title)
  return index === -1 ? CHANGE_TYPES.length : index
}

function parseSections(lines: readonly string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of lines) {
    const line = raw.trimEnd()
    const heading = /^###\s+(.+)$/.exec(line)
    if (heading !== null) {
      current = heading[1] ?? ''
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (line.trim() === '' || current === null) continue
    if (STUB_PATTERN.test(line)) continue
    sections.get(current)?.push(line)
  }
  for (const [title, bullets] of sections) {
    if (bullets.length === 0) sections.delete(title)
  }
  return sections
}

export function parseChangelog(text: string): ParsedChangelog {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING)
  if (start === -1) {
    const firstRelease = lines.findIndex((line) => /^##\s+\[/.test(line))
    const cut = firstRelease === -1 ? lines.length : firstRelease
    return {
      head: lines.slice(0, cut).join('\n').trimEnd(),
      unreleased: new Map(),
      rest: lines.slice(cut).join('\n').trim(),
    }
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  return {
    head: lines.slice(0, start).join('\n').trimEnd(),
    unreleased: parseSections(lines.slice(start + 1, end)),
    rest: lines.slice(end).join('\n').trim(),
  }
}

function renderSections(sections: ReadonlyMap<string, readonly string[]>): string {
  const titles = [...sections.keys()].sort((a, b) => sectionRank(a) - sectionRank(b))
  return titles
    .map((title) => `### ${title}\n\n${(sections.get(title) ?? []).join('\n')}`)
    .join('\n\n')
}

function assemble(head: string, unreleased: string, rest: string): string {
  const parts = [
    head.length > 0 ? head : HEADER,
    `${UNRELEASED_HEADING}${unreleased.length > 0 ? `\n\n${unreleased}` : ''}`,
  ]
  if (rest.length > 0) parts.push(rest)
  return `${parts.join('\n\n')}\n`
}

/** Count the real entries waiting under `[Unreleased]` (the stub is not one). */
export function unreleasedEntryCount(text: string): number {
  let count = 0
  for (const bullets of parseChangelog(text).unreleased.values()) count += bullets.length
  return count
}

/** Add one bullet under `[Unreleased]`, creating the section when missing. */
export function addEntry(text: string, line: string, type: ChangeType = 'changed'): string {
  const entry = line.trim().replace(/^-\s+/, '')
  if (entry.length === 0) throw new Error('changelog entry is empty')
  const parsed = parseChangelog(text)
  const sections = new Map<string, string[]>()
  for (const [title, bullets] of parsed.unreleased) sections.set(title, [...bullets])
  const title = titleOf(type)
  const bullet = `- ${entry}`
  const existing = sections.get(title) ?? []
  if (!existing.includes(bullet)) existing.push(bullet)
  sections.set(title, existing)
  return assemble(parsed.head, renderSections(sections), parsed.rest)
}

export interface ReleaseResult {
  readonly text: string
  /** The version block already existed, so nothing was moved. */
  readonly skipped: boolean
  /** The `[Unreleased]` block was empty and the rebuilt line was written. */
  readonly rebuilt: boolean
}

/**
 * Move `[Unreleased]` under `## [<version>] - <date>`. An empty block gets
 * `REBUILT_LINE`: a package forced into a publish with no change of its own.
 */
export function releaseUnreleased(text: string, version: string, date: string): ReleaseResult {
  const heading = `## [${version}]`
  if (text.split('\n').some((line) => line.startsWith(heading))) {
    return { text, skipped: true, rebuilt: false }
  }
  const parsed = parseChangelog(text)
  const rebuilt = parsed.unreleased.size === 0
  const sections = rebuilt ? new Map([['Changed', [`- ${REBUILT_LINE}`]]]) : parsed.unreleased
  const released = `## [${version}] - ${date}\n\n${renderSections(sections)}`
  const rest = parsed.rest.length > 0 ? `${released}\n\n${parsed.rest}` : released
  return { text: assemble(parsed.head, '', rest), skipped: false, rebuilt }
}

/** A brand-new changelog whose first release block is already written. */
export function firstRelease(version: string, date: string, lines: readonly string[]): string {
  const sections = new Map([['Added', lines.map((line) => `- ${line}`)]])
  return assemble(HEADER, '', `## [${version}] - ${date}\n\n${renderSections(sections)}`)
}

/** True when the file is the old stub: no release block and no real entry. */
export function isStub(text: string): boolean {
  return !/^##\s+\[\d/m.test(text) && unreleasedEntryCount(text) === 0
}
