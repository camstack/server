import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareVersions,
  pickUiDist,
  readUiDistCandidate,
  resolveUiDistDir,
} from '../agent-http.js'

describe('compareVersions', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('1.1.13', '1.1.1')).toBeGreaterThan(0)
    expect(compareVersions('1.1.1', '1.1.13')).toBeLessThan(0)
    expect(compareVersions('1.1.13', '1.1.13')).toBe(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
  })

  it('treats null as the lowest version', () => {
    expect(compareVersions(null, '0.0.1')).toBeLessThan(0)
    expect(compareVersions('0.0.1', null)).toBeGreaterThan(0)
    expect(compareVersions(null, null)).toBe(0)
  })

  it('handles versions of different segment counts', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0)
    expect(compareVersions('1.1.0.1', '1.1')).toBeGreaterThan(0)
  })
})

describe('pickUiDist', () => {
  it('prefers the newer version regardless of order', () => {
    expect(
      pickUiDist(
        { dir: '/installed/dist', version: '1.1.1' },
        { dir: '/bundled/dist', version: '1.1.13' },
      ),
    ).toBe('/bundled/dist')
    expect(
      pickUiDist(
        { dir: '/installed/dist', version: '2.0.0' },
        { dir: '/bundled/dist', version: '1.1.13' },
      ),
    ).toBe('/installed/dist')
  })

  it('prefers the installed copy on version tie (deploy-updatable)', () => {
    expect(
      pickUiDist(
        { dir: '/installed/dist', version: '1.1.13' },
        { dir: '/bundled/dist', version: '1.1.13' },
      ),
    ).toBe('/installed/dist')
  })

  it('falls back to whichever candidate exists', () => {
    expect(pickUiDist(null, { dir: '/bundled/dist', version: '1.1.13' })).toBe('/bundled/dist')
    expect(pickUiDist({ dir: '/installed/dist', version: null }, null)).toBe('/installed/dist')
    expect(pickUiDist(null, null)).toBeNull()
  })
})

describe('readUiDistCandidate + resolveUiDistDir', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-dist-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function writePkg(base: string, version: string): void {
    fs.mkdirSync(path.join(base, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(base, 'dist', 'index.html'), '<!doctype html>')
    fs.writeFileSync(
      path.join(base, 'package.json'),
      JSON.stringify({ name: '@camstack/addon-agent-ui', version }),
    )
  }

  it('readUiDistCandidate returns dist dir + version, null when index.html is missing', () => {
    const base = path.join(tmp, 'pkg')
    writePkg(base, '1.2.3')
    expect(readUiDistCandidate(base)).toEqual({ dir: path.join(base, 'dist'), version: '1.2.3' })
    expect(readUiDistCandidate(path.join(tmp, 'missing'))).toBeNull()
  })

  it('serves the bundled UI when it is newer than the seeded install (packaged app update)', () => {
    const dataDir = path.join(tmp, 'data')
    const bundledDir = path.join(tmp, 'bundled')
    writePkg(path.join(dataDir, 'addons', '@camstack', 'addon-agent-ui'), '1.1.1')
    writePkg(path.join(bundledDir, 'addon-agent-ui'), '1.1.13')
    expect(resolveUiDistDir(dataDir, bundledDir)).toBe(
      path.join(bundledDir, 'addon-agent-ui', 'dist'),
    )
  })

  it('serves the installed UI when it is newer (camstack deploy of a newer addon)', () => {
    const dataDir = path.join(tmp, 'data')
    const bundledDir = path.join(tmp, 'bundled')
    writePkg(path.join(dataDir, 'addons', '@camstack', 'addon-agent-ui'), '1.2.0')
    writePkg(path.join(bundledDir, 'addon-agent-ui'), '1.1.13')
    expect(resolveUiDistDir(dataDir, bundledDir)).toBe(
      path.join(dataDir, 'addons', '@camstack', 'addon-agent-ui', 'dist'),
    )
  })

  it('reads the bundled copy out of the CLOSURE SCOPE dir the packaged app now passes', () => {
    // `CAMSTACK_BUNDLED_ADDONS_DIR` moved from a second `Resources/addons` tree
    // to the closure's own `Resources/node_modules/@camstack` (2026-08-25). This
    // function is the only RUNTIME reader that opens a package inside that dir,
    // so the scope layout is pinned here: break the coupling and the desktop
    // agent silently serves a stale UI instead of the one it shipped with.
    const dataDir = path.join(tmp, 'data')
    const resources = path.join(tmp, 'Resources')
    const scopeDir = path.join(resources, 'node_modules', '@camstack')
    writePkg(path.join(dataDir, 'addons', '@camstack', 'addon-agent-ui'), '1.1.1')
    writePkg(path.join(scopeDir, 'addon-agent-ui'), '1.2.9')
    expect(resolveUiDistDir(dataDir, scopeDir)).toBe(path.join(scopeDir, 'addon-agent-ui', 'dist'))
  })

  it('falls back to the legacy dataDir/agent-ui location', () => {
    const dataDir = path.join(tmp, 'data')
    fs.mkdirSync(path.join(dataDir, 'agent-ui'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'agent-ui', 'index.html'), '<!doctype html>')
    expect(resolveUiDistDir(dataDir, undefined)).toBe(path.join(dataDir, 'agent-ui'))
  })

  it('returns null when no candidate exists', () => {
    expect(resolveUiDistDir(path.join(tmp, 'nope'), undefined)).toBeNull()
  })
})

/**
 * The agent's UI comes from the addon root, like every other addon file.
 *
 * `resolveUiDistDir` used to return a sibling `dist/` resolved out of the
 * server closure — `path.resolve(__dirname, '../../addon-agent-ui/dist')` —
 * with ABSOLUTE priority, before the installed copy was even looked at. Its
 * comment claimed it was "always version-matched to the agent", and the
 * tie-breaker that grew beside it (`pickUiDist`, newest of installed vs
 * bundled) exists precisely because it was not: an app at one version serving
 * a UI from another.
 *
 * It was the ONLY runtime consumer anywhere that read an addon out of the
 * closure, on any role, and nothing pinned it.
 */
describe('resolveUiDistDir reads only the addon root', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-root-'))
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function installUi(version: string): string {
    const dir = path.join(dataDir, 'addons', '@camstack', 'addon-agent-ui')
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<html></html>')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))
    return path.join(dir, 'dist')
  }

  it('serves the copy installed under addons', () => {
    const expected = installUi('1.2.113')
    expect(resolveUiDistDir(dataDir)).toBe(expected)
  })

  it('answers null when nothing is installed, instead of reaching elsewhere', () => {
    // The honest answer. Reaching into the closure is what made an agent serve
    // a UI from a different generation than the addon beside it.
    expect(resolveUiDistDir(dataDir)).toBeNull()
  })
})
