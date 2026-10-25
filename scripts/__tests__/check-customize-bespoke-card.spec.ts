/**
 * D936 — a declared customize cap has no bespoke card or builder outside the
 * generic folders. A planted name fails; the tree on main does not.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAP_CUSTOMIZE_CATALOG } from '../../packages/types/src/generated/customize-catalog.ts'
import {
  bespokeCustomizeHits,
  isGenericCustomizePath,
  scanCustomizeSources,
} from '../lib/customize-bespoke.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CAPS = Object.keys(CAP_CUSTOMIZE_CATALOG)

describe('customize bespoke-card guard', () => {
  it('a planted DoorbellAssignment outside the generic folders is a hit', () => {
    const hits = bespokeCustomizeHits(
      [
        {
          path: 'packages/addon-admin-ui/src/components/device/customize/kinds/DoorbellAssignment.tsx',
          text: 'export function DoorbellAssignment() { return null }\n',
        },
      ],
      CAPS,
    )
    expect(hits.map((hit) => hit.cap)).toContain('doorbell')
    expect(hits.length).toBeGreaterThan(0)
  })

  it('the same name inside the generic event folder is not a hit', () => {
    const file = 'packages/addon-admin-ui/src/components/device/customize/event/EventPulseCard.tsx'
    expect(isGenericCustomizePath(file)).toBe(true)
    expect(
      bespokeCustomizeHits(
        [{ path: file, text: 'export function DoorbellAssignment() { return null }\n' }],
        CAPS,
      ),
    ).toEqual([])
  })

  it('the tree has no leftover card or builder', () => {
    expect(bespokeCustomizeHits(scanCustomizeSources(repoRoot), CAPS)).toEqual([])
  })
})
