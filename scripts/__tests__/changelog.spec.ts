import { describe, expect, it } from 'vitest'
import {
  REBUILT_LINE,
  addEntry,
  firstRelease,
  isStub,
  releaseUnreleased,
  unreleasedEntryCount,
} from '../lib/changelog'

const STUB = `# Changelog

All notable changes to this package are documented in this file.

## [Unreleased]

### Added

- Package README and changelog, included in the published files list.
`

describe('changelog text operations', () => {
  it('treats the generated placeholder as no entry', () => {
    expect(unreleasedEntryCount(STUB)).toBe(0)
    expect(isStub(STUB)).toBe(true)
  })

  it('adds a line and drops the placeholder', () => {
    const out = addEntry(STUB, 'Cameras reconnect after a hub restart.', 'fixed')
    expect(unreleasedEntryCount(out)).toBe(1)
    expect(out).toContain('### Fixed\n\n- Cameras reconnect after a hub restart.')
    expect(out).not.toContain('Package README and changelog')
  })

  it('creates the Unreleased section when it is missing and keeps releases below', () => {
    const released = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First.\n'
    const out = addEntry(released, 'Second.', 'added')
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [1.0.0]'))
    expect(out).toContain('- First.')
    expect(unreleasedEntryCount(out)).toBe(1)
  })

  it('orders sections added, changed, removed, fixed and ignores a duplicate line', () => {
    let out = addEntry('', 'A fix.', 'fixed')
    out = addEntry(out, 'A feature.', 'added')
    out = addEntry(out, 'A feature.', 'added')
    expect(out.indexOf('### Added')).toBeLessThan(out.indexOf('### Fixed'))
    expect(unreleasedEntryCount(out)).toBe(2)
  })

  it('moves Unreleased under the new version and leaves an empty Unreleased', () => {
    const withEntry = addEntry(STUB, 'Faster start.', 'changed')
    const { text, rebuilt } = releaseUnreleased(withEntry, '1.2.4', '2026-10-27')
    expect(rebuilt).toBe(false)
    expect(text).toMatch(
      /## \[Unreleased\]\n\n## \[1\.2\.4\] - 2026-10-27\n\n### Changed\n\n- Faster start\./,
    )
    expect(unreleasedEntryCount(text)).toBe(0)
  })

  it('writes the rebuilt line when a forced package has no entries', () => {
    const { text, rebuilt } = releaseUnreleased(STUB, '2.0.1', '2026-10-27')
    expect(rebuilt).toBe(true)
    expect(text).toContain(`## [2.0.1] - 2026-10-27\n\n### Changed\n\n- ${REBUILT_LINE}`)
  })

  it('does not release the same version twice', () => {
    const once = releaseUnreleased(addEntry(STUB, 'X.', 'added'), '1.0.1', '2026-10-27').text
    const again = releaseUnreleased(addEntry(once, 'Y.', 'added'), '1.0.1', '2026-10-28')
    expect(again.skipped).toBe(true)
    expect(again.text.match(/## \[1\.0\.1\]/g)?.length).toBe(1)
  })

  it('writes a first release for a package that had no changelog', () => {
    const out = firstRelease('1.2.3', '2026-10-27', ['Does a thing.'])
    expect(out).toContain('## [Unreleased]')
    expect(out).toContain('## [1.2.3] - 2026-10-27')
    expect(isStub(out)).toBe(false)
  })
})
