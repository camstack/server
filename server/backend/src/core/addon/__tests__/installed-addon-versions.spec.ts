import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readInstalledAddonVersions } from '../installed-addon-versions'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-addons-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function pkg(rel: string, content: string): void {
  fs.mkdirSync(path.join(dir, rel), { recursive: true })
  fs.writeFileSync(path.join(dir, rel, 'package.json'), content)
}

describe('readInstalledAddonVersions', () => {
  it('reads scoped and flat installs, and answers null for an unreadable version', () => {
    pkg('@camstack/addon-a', JSON.stringify({ name: '@camstack/addon-a', version: '1.2.3' }))
    pkg('addon-b', JSON.stringify({ name: '@camstack/addon-b', version: '2.0.0' }))
    pkg('@camstack/addon-c', JSON.stringify({ name: '@camstack/addon-c' }))
    pkg('@camstack/addon-d', '{ not json')
    pkg('other', JSON.stringify({ name: 'left-pad', version: '1.0.0' }))
    expect(readInstalledAddonVersions(dir)).toEqual({
      '@camstack/addon-a': '1.2.3',
      '@camstack/addon-b': '2.0.0',
      '@camstack/addon-c': null,
    })
  })

  it('answers empty for a missing dir', () => {
    expect(readInstalledAddonVersions(path.join(dir, 'nope'))).toEqual({})
  })
})
