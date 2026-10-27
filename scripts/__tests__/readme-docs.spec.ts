import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allProblems } from '../check-addon-readme-changelog'
import { staleReadmes } from '../check-readmes-current'
import { settingsFromLabels } from '../lib/readme-docs'
import { readWorkspacePackages } from '../lib/workspace-packages'
import { generateFor } from '../readme-generate'

let root = ''

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function addon(capabilities: readonly string[]): Record<string, unknown> {
  return {
    name: '@camstack/addon-demo',
    version: '1.2.3',
    description: 'Demo addon for CamStack',
    files: ['dist'],
    camstack: {
      displayName: 'Demo',
      addons: [
        {
          id: 'demo',
          name: 'Demo',
          category: 'utilities',
          execution: { placement: 'hub-only' },
          capabilities: capabilities.map((name) => ({ name })),
        },
      ],
    },
  }
}

function generateAll(): void {
  for (const pkg of readWorkspacePackages(root)) generateFor(root, pkg)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-docs-'))
  writeJson(path.join(root, 'packages/addon-demo/package.json'), addon(['alpha-cap']))
  writeJson(path.join(root, 'packages/addon-demo/i18n/en.json'), {
    'globalSettings.s_basics.title': 'Basics',
    'globalSettings.s_basics.hostname.label': 'Hostname',
    'globalSettings.s_basics.hostname.o_a.label': 'Option label, not a field',
  })
  writeJson(path.join(root, 'packages/core/package.json'), {
    name: '@camstack/core',
    version: '3.0.0',
    description: 'Framework package',
    files: ['dist'],
  })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readme generation', () => {
  it('derives provides, configuration and placement from the manifest and labels', () => {
    generateAll()
    const readme = fs.readFileSync(path.join(root, 'packages/addon-demo/README.md'), 'utf8')
    expect(readme).toContain('# Demo')
    expect(readme).toContain('`alpha-cap`')
    expect(readme).toContain('- Basics: Hostname')
    expect(readme).not.toContain('Option label')
    expect(readme).toContain('Placement: hub-only')
  })

  it('keeps hand-written text and rewrites only the derived block', () => {
    generateAll()
    const file = path.join(root, 'packages/addon-demo/README.md')
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n## Notes\n\nHand-written note.\n`)
    const prose = fs.readFileSync(file, 'utf8').replace('Demo addon for CamStack.', 'Written by hand.')
    fs.writeFileSync(file, prose)
    writeJson(path.join(root, 'packages/addon-demo/package.json'), addon(['alpha-cap', 'beta-cap']))
    expect(staleReadmes(root)).toContain('packages/addon-demo')
    generateAll()
    const after = fs.readFileSync(file, 'utf8')
    expect(after).toContain('Written by hand.')
    expect(after).toContain('Hand-written note.')
    expect(after).toContain('`beta-cap`')
    expect(staleReadmes(root)).toEqual([])
  })

  it('seeds a first changelog entry under the current version, and packs both files', () => {
    generateAll()
    const log = fs.readFileSync(path.join(root, 'packages/core/CHANGELOG.md'), 'utf8')
    expect(log).toMatch(/## \[3\.0\.0\] - 2026-10-27/)
    expect(log).toContain('Framework package')
    expect(allProblems(root)).toEqual([])
  })

  it('lists the settings sections of a label map', () => {
    const groups = settingsFromLabels({
      'connection.s_credentials.password.label': 'Password',
      'connection.s_credentials.title': 'Credentials',
    })
    expect(groups[0]?.sections.get('Credentials')).toEqual(['Password'])
  })
})

describe('check-addon-readme-changelog covers framework packages', () => {
  it('flags a published framework package without README, CHANGELOG or files entries', () => {
    const messages = allProblems(root).map((problem) => `${problem.pkg}: ${problem.message}`)
    expect(messages).toContain('@camstack/core: README.md is missing or empty')
    expect(messages).toContain('@camstack/core: files does not include CHANGELOG.md')
  })

  it('does not ask a private package to publish anything', () => {
    writeJson(path.join(root, 'packages/hidden/package.json'), { name: '@camstack/hidden', version: '1.0.0', private: true })
    expect(allProblems(root).some((problem) => problem.pkg === '@camstack/hidden')).toBe(false)
  })
})
