import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addedEntryLines,
  describeMisplaced,
  describeMissing,
  isUserVisibleChange,
  misplacedEntries,
  missingEntries,
} from '../check-changelog-unreleased'
import { addEntry } from '../lib/changelog'
import { releaseDirs } from '../release-changelog'

let root = ''

function writePackage(dir: string, manifest: Record<string, unknown>, changelog: string): void {
  const full = path.join(root, dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(full, 'CHANGELOG.md'), changelog)
}

const EMPTY = '# Changelog\n\n## [Unreleased]\n'

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-guard-'))
  writePackage('packages/alpha', { name: '@camstack/alpha', version: '1.0.0' }, EMPTY)
  writePackage(
    'packages/beta',
    { name: '@camstack/beta', version: '2.0.0' },
    addEntry(EMPTY, 'Beta does more.'),
  )
  writePackage(
    'packages/hidden',
    { name: '@camstack/hidden', version: '0.1.0', private: true },
    EMPTY,
  )
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('check-changelog-unreleased', () => {
  it('flags a changed package with no Unreleased entry and names the command', () => {
    const missing = missingEntries({ root, changedFiles: ['packages/alpha/src/index.ts'] })
    expect(missing.map((entry) => entry.dir)).toEqual(['packages/alpha'])
    expect(describeMissing(missing)).toContain('npm run changelog:add -- alpha')
  })

  it('accepts a changed package that wrote its entry', () => {
    expect(missingEntries({ root, changedFiles: ['packages/beta/src/index.ts'] })).toEqual([])
  })

  it('ignores specs, the changelog itself, docs and private packages', () => {
    const changedFiles = [
      'packages/alpha/src/__tests__/a.spec.ts',
      'packages/alpha/src/thing.test.ts',
      'packages/alpha/CHANGELOG.md',
      'packages/alpha/README.md',
      'packages/hidden/src/index.ts',
    ]
    expect(missingEntries({ root, changedFiles })).toEqual([])
  })

  it('does not count the placeholder stub as an entry', () => {
    const stub =
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Package README and changelog, included in the published files list.\n'
    fs.writeFileSync(path.join(root, 'packages/alpha/CHANGELOG.md'), stub)
    expect(missingEntries({ root, changedFiles: ['packages/alpha/src/x.ts'] })).toHaveLength(1)
  })

  it('narrows to the packages a publish is about to ship', () => {
    const changedFiles = ['packages/alpha/src/x.ts']
    expect(missingEntries({ root, changedFiles, only: ['packages/beta'] })).toEqual([])
    expect(missingEntries({ root, changedFiles, only: ['packages/alpha'] })).toHaveLength(1)
  })

  it('classifies what an operator could notice', () => {
    expect(isUserVisibleChange('src/addon.ts')).toBe(true)
    expect(isUserVisibleChange('package.json')).toBe(true)
    expect(isUserVisibleChange('src/__tests__/a.ts')).toBe(false)
    expect(isUserVisibleChange('AGENTS.md')).toBe(false)
  })
})

describe('release step', () => {
  it('moves entries under the bumped version and rebuilds a forced package', () => {
    const messages = releaseDirs(
      root,
      ['packages/beta', 'packages/alpha', 'packages/hidden'],
      '2026-10-27',
    )
    expect(messages).toHaveLength(2)
    const beta = fs.readFileSync(path.join(root, 'packages/beta/CHANGELOG.md'), 'utf8')
    expect(beta).toContain('## [2.0.0] - 2026-10-27')
    expect(beta).toContain('- Beta does more.')
    const alpha = fs.readFileSync(path.join(root, 'packages/alpha/CHANGELOG.md'), 'utf8')
    expect(alpha).toContain('Rebuilt against updated dependencies.')
    expect(missingEntries({ root, changedFiles: ['packages/beta/src/x.ts'] })).toHaveLength(1)
  })
})

describe('misplacedEntries', () => {
  const cherryPicked = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Fixed',
    '',
    '- Already unreleased.',
    '',
    '## [1.2.0] - 2026-10-30',
    '',
    '### Changed',
    '',
    '- Cherry-picked line that landed under the release.',
    '- Released by the bot.',
    '',
  ].join('\n')

  it('names a line added under a released heading', () => {
    const found = misplacedEntries(cherryPicked, [
      '- Already unreleased.',
      '- Cherry-picked line that landed under the release.',
    ])
    expect(found).toEqual([
      {
        line: '- Cherry-picked line that landed under the release.',
        heading: '## [1.2.0] - 2026-10-30',
      },
    ])
  })

  it('passes when every added line sits under [Unreleased]', () => {
    expect(misplacedEntries(cherryPicked, ['- Already unreleased.'])).toEqual([])
  })

  it('does not blame a line whose text is also under [Unreleased]', () => {
    const text = '## [Unreleased]\n\n- Same.\n\n## [1.0.0] - 2026-01-01\n\n- Same.\n'
    expect(misplacedEntries(text, ['- Same.'])).toEqual([])
  })

  it('parses only entry lines out of a diff', () => {
    const diff = [
      '--- a/x',
      '+++ b/x',
      '+## [Unreleased]',
      '+- Added one.',
      '-- removed',
      ' - ctx',
    ].join('\n')
    expect(addedEntryLines(diff)).toEqual(['- Added one.'])
  })

  it('describes package, truncated line and heading with the fix', () => {
    const message = describeMisplaced([
      {
        dir: 'packages/alpha',
        name: '@camstack/alpha',
        line: `- ${'x'.repeat(200)}`,
        heading: '## [1.2.0] - 2026-10-30',
      },
    ])
    expect(message).toContain('@camstack/alpha')
    expect(message).toContain('## [1.2.0] - 2026-10-30')
    expect(message).toContain('move it under ## [Unreleased]')
    expect(message).not.toContain('x'.repeat(101))
  })
})
