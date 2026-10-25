import { describe, it, expect, vi } from 'vitest'
import type { Accessory } from '@homebridge/hap-nodejs'
import type { IScopedLogger } from '@camstack/types'
import { firstExposedAccessorySetupUri } from '../hap-setup-uri.js'
import type { Mapper } from '../mappers/types.js'

/**
 * `firstExposedAccessorySetupUri` reads the X-HM://… pairing URI off the
 * first standalone accessory the addon has currently published, so the
 * shared `DeviceExportPanel` can render it as a scannable QR. Each
 * accessory carries its OWN URI (per-accessory category + setupID bits)
 * even though the pincode is shared across the addon — scanning the
 * panel QR pairs the first camera; subsequent cameras are added via
 * iOS Home → + → Add Accessory with the same pincode.
 */

function makeMapper(accessories: ReadonlyArray<Pick<Accessory, 'setupURI'>>): Mapper {
  return {
    accessory: accessories[0] as Accessory,
    accessories: accessories as readonly Accessory[],
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

describe('firstExposedAccessorySetupUri', () => {
  it('returns undefined when no accessory has been exposed yet', () => {
    const empty: ReadonlyMap<string, Mapper> = new Map()
    expect(firstExposedAccessorySetupUri(empty, makeLogger())).toBeUndefined()
  })

  it('returns the first exposed accessory setupURI', () => {
    const exposed = new Map<string, Mapper>([
      ['97', makeMapper([{ setupURI: () => 'X-HM://0042ABCDE' }])],
    ])
    expect(firstExposedAccessorySetupUri(exposed, makeLogger())).toBe('X-HM://0042ABCDE')
  })

  it('ignores subsequent exposed accessories — only the first is surfaced', () => {
    // Map iteration order matches insertion order. The panel QR encodes
    // exactly one accessory; operators add the rest manually with the
    // shared pincode.
    const exposed = new Map<string, Mapper>([
      ['97', makeMapper([{ setupURI: () => 'X-HM://FIRST' }])],
      ['98', makeMapper([{ setupURI: () => 'X-HM://SECOND' }])],
    ])
    expect(firstExposedAccessorySetupUri(exposed, makeLogger())).toBe('X-HM://FIRST')
  })

  it('skips mappers that have no accessories[0]', () => {
    const exposed = new Map<string, Mapper>([
      ['97', makeMapper([])],
      ['98', makeMapper([{ setupURI: () => 'X-HM://SECOND' }])],
    ])
    expect(firstExposedAccessorySetupUri(exposed, makeLogger())).toBe('X-HM://SECOND')
  })

  it('returns undefined and logs at debug when setupURI throws', () => {
    const logger = makeLogger()
    const exposed = new Map<string, Mapper>([
      [
        '97',
        makeMapper([
          {
            setupURI: () => {
              throw new Error('accessory not published yet')
            },
          },
        ]),
      ],
    ])
    expect(firstExposedAccessorySetupUri(exposed, logger)).toBeUndefined()
    expect(logger.debug).toHaveBeenCalledOnce()
  })
})
