import { describe, expect, it } from 'vitest'
import {
  hiddenOlderVersionCount,
  versionsForPicker,
  type VersionListEntry,
} from '../visible-versions'

const VERSIONS: readonly VersionListEntry[] = [
  { version: '2.0.0', distTags: ['latest'], deprecated: undefined },
  { version: '2.0.0-beta.1', distTags: ['beta'], deprecated: undefined },
  { version: '1.9.0', distTags: [], deprecated: 'please use latest' },
  { version: '1.0.0', distTags: [], deprecated: 'please use latest' },
]

describe('versionsForPicker', () => {
  it('shows latest and non-deprecated versions, and hides deprecated ones', () => {
    expect(versionsForPicker(VERSIONS, false).map((entry) => entry.version)).toEqual([
      '2.0.0',
      '2.0.0-beta.1',
    ])
    expect(hiddenOlderVersionCount(VERSIONS)).toBe(2)
  })

  it('reveals deprecated versions when older versions are requested', () => {
    expect(versionsForPicker(VERSIONS, true).map((entry) => entry.version)).toEqual([
      '2.0.0',
      '2.0.0-beta.1',
      '1.9.0',
      '1.0.0',
    ])
  })

  it('keeps a deprecated latest visible, because latest is the install target', () => {
    const rows: readonly VersionListEntry[] = [
      { version: '3.0.0', distTags: ['latest'], deprecated: 'yanked build, still the tag' },
      { version: '2.0.0', distTags: [], deprecated: 'old' },
    ]
    expect(versionsForPicker(rows, false).map((entry) => entry.version)).toEqual(['3.0.0'])
  })
})
