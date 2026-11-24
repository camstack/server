import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #666 — the accessory sleep gate asks the parent `isBatteryCam()`. That used to
 * read the `feature-probe` slice, which a battery camera asleep at boot never
 * seeds (the parent's `onProbe` skips), so the answer was `false` and every
 * accessory probed straight through the gate. The host answers from the SAME
 * `isBattery` the parent's own sleep gates use — no second copy.
 */
const camera = readFileSync(fileURLToPath(new URL('../reolink-camera.ts', import.meta.url)), 'utf8')

describe('ReolinkAccessoryHost.isBatteryCam', () => {
  const start = camera.indexOf('  isBatteryCam(): boolean {')
  const body = camera.slice(start, camera.indexOf('\n  }\n', start))

  it('answers from the constructor-set isBattery, not from the probe slice', () => {
    expect(start).toBeGreaterThanOrEqual(0)
    expect(body).toContain('this.isBattery')
    expect(body).not.toContain("'feature-probe'")
  })
})
