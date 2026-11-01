import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyStamp, computeStamps } from '../ci/stamp-requires.mjs'

interface Entry {
  dir: string
  pkg: { name: string; version: string; camstack?: Record<string, unknown> }
}

const addon = (name: string, version: string): Entry => ({
  dir: `packages/${name}`,
  pkg: { name: `@camstack/${name}`, version, camstack: { addons: [] } },
})
const server: Entry = {
  dir: 'server/backend',
  pkg: { name: '@camstack/server', version: '1.2.718', camstack: { addons: [] } },
}
const wrapperMinimums = { desktop: '>=0.1.6', image: '>=1.2.700' }

describe('stamp-requires (D988)', () => {
  it('stamps every addon in the set with the server it was cut against', () => {
    const stamps = computeStamps({
      packages: [addon('addon-a', '1.0.5'), addon('addon-b', '2.0.1')],
      serverVersion: '1.2.718',
      wrapperMinimums,
    })
    expect(stamps.get('packages/addon-a')).toEqual({ server: '>=1.2.718' })
    expect(stamps.get('packages/addon-b')).toEqual({ server: '>=1.2.718' })
    expect(stamps.has('server/backend')).toBe(false)
  })

  it('stamps the server with the addons published beside it and the wrapper minimums', () => {
    const stamps = computeStamps({
      packages: [server, addon('addon-a', '1.0.5')],
      serverVersion: '1.2.718',
      wrapperMinimums,
    })
    expect(stamps.get('server/backend')).toEqual({
      addons: { '@camstack/addon-a': '>=1.0.5' },
      wrapper: wrapperMinimums,
    })
  })

  it('leaves a non-addon package unstamped', () => {
    const stamps = computeStamps({
      packages: [{ dir: 'packages/types', pkg: { name: '@camstack/types', version: '1.0.0' } }],
      serverVersion: '1.2.718',
      wrapperMinimums,
    })
    expect(stamps.size).toBe(0)
  })

  it('writes the block into package.json and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'))
    const dir = 'packages/addon-a'
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    const file = path.join(root, dir, 'package.json')
    fs.writeFileSync(
      file,
      `${JSON.stringify({ name: '@camstack/addon-a', version: '1.0.5', camstack: { addons: [] } }, null, 2)}\n`,
    )
    expect(applyStamp(dir, { server: '>=1.2.718' }, root)).toBe(true)
    const stamped = fs.readFileSync(file, 'utf-8')
    expect(JSON.parse(stamped).camstack).toEqual({ addons: [], requires: { server: '>=1.2.718' } })
    expect(applyStamp(dir, { server: '>=1.2.718' }, root)).toBe(false)
    expect(fs.readFileSync(file, 'utf-8')).toBe(stamped)
  })
})
