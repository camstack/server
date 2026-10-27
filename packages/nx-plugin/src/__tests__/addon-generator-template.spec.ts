import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * D777: the capability toggle is an addon's ONE enable. The generated addon
 * must not ship a private `enabled` "master switch" — a second enable that
 * nothing reads and that can contradict the toggle.
 */
const TEMPLATE = path.join(
  __dirname,
  '..',
  'generators',
  'addon',
  'files',
  'src',
  '__addon__.addon.ts.template',
)

describe('addon generator template', () => {
  it('declares no `enabled` master switch', () => {
    const text = fs.readFileSync(TEMPLATE, 'utf8')
    expect(text).not.toMatch(/\benabled\b/)
    expect(text).not.toMatch(/master switch/i)
  })

  const FILES = path.join(__dirname, '..', 'generators', 'addon', 'files')

  it('ships a README with the generated block and a CHANGELOG with [Unreleased]', () => {
    const readme = fs.readFileSync(path.join(FILES, 'README.md.template'), 'utf8')
    expect(readme).toContain('<!-- readme:generated:start')
    expect(readme).toContain('<!-- readme:generated:end -->')
    const changelog = fs.readFileSync(path.join(FILES, 'CHANGELOG.md.template'), 'utf8')
    expect(changelog).toContain('## [Unreleased]')
    expect(changelog).toMatch(/### Added\n\n- Initial release\./)
  })

  it('packs the README and CHANGELOG', () => {
    const pkg = fs.readFileSync(path.join(FILES, 'package.json.template'), 'utf8')
    expect(pkg).toMatch(/"files": \["dist", "README\.md", "CHANGELOG\.md"\]/)
  })
})
