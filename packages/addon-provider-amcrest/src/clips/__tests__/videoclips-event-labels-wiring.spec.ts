/**
 * The camera's own clips carry OUR detections (D923): the `videoclips`
 * provider this addon registers is wrapped by `withClipEventLabels`, fed from
 * this addon's own `ctx.api`. The join itself is proved in `@camstack/types`
 * (`clip-event-labels.spec.ts`); this proves it is WIRED — a helper nobody
 * registers labels nothing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const addonSource = readFileSync(fileURLToPath(new URL('../../addon.ts', import.meta.url)), 'utf8')

describe('amcrest videoclips registration', () => {
  it('registers the clip provider wrapped with our event labels', () => {
    expect(addonSource).toMatch(
      /capability:\s*videoclipsCapability,\s*provider:\s*withClipEventLabels\(\s*this\.clipService\.provider,\s*clipEventLabelDepsFromApi\(this\.ctx\.api, this\.ctx\.logger\)/,
    )
  })
})
