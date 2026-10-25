import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * One privacy mask, one authority.
 *
 * This provider had TWO writers for the camera's mask master switch:
 *
 *   the `privacy-mask` cap      → api.setMaskZones(channel, { enable, ... })
 *   a driver-form `boolean`     → api.setMask(channel, { enable })
 *
 * and they did not even read the same thing: the cap reads the camera, while
 * the form field read `config.get('privacyMaskEnabled')` — a copy of our own.
 * So device details and the Reolink app could disagree about whether a
 * bedroom was blacked out, which is the one row where being wrong about the
 * polarity matters most.
 *
 * That is the "two knobs, one store nobody reads" defect D62 was written
 * around and D113 and D544 both keep verbatim: a per-camera function switch
 * stores NOTHING and writes the authority that already owns the function. The
 * `privacy-mask` cap is that authority. The form field is gone.
 */

const here = dirname(fileURLToPath(import.meta.url))
const camera = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')
const schema = readFileSync(resolve(here, '../schema.ts'), 'utf8')

describe('the privacy mask has one writer', () => {
  it('the driver form no longer carries a mask switch of its own', () => {
    expect(camera).not.toContain('privacyMaskEnabled')
    expect(schema).not.toContain('privacyMaskEnabled')
  })

  it('and nothing calls the single-field setMask any more', () => {
    // `setMaskZones` (the cap's write, enable + zones together) stays.
    expect(camera).not.toMatch(/api\.setMask\(/)
    expect(camera).toContain('setMaskZones(')
  })
})
