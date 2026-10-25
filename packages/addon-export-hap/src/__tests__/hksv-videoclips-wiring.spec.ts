/**
 * What makes a camera HAVE a HomeKit clip source, and what makes the hub
 * DERIVE it.
 *
 * Two separate wirings, and missing either one is silent:
 *
 *  - The FACTS. The source exists because the camera is exported to HomeKit
 *    and HomeKit has not said no to recording it (D550, D569 § 5, D589). Both
 *    are read from the authorities that already own them — the persisted
 *    exposure, and HomeKit's own `Active` characteristic — never from a knob
 *    of this source's own, and never from a copy of somebody else's.
 *  - The MANIFEST. `videoclips` is a `mode:'collection'` wrapper, and a
 *    camera's bindings are derived from the addons whose MANIFEST declares the
 *    capability (`declareFromManifest` registers a wrapper provider;
 *    `collectionBindings` then gates only on the cap's `deviceTypes`). An
 *    addon that registers the provider in code and forgets the manifest entry
 *    compiles, boots, and never appears in `getBindings` — so the picker never
 *    shows the source and `listClips` refuses the addon id by name.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { HksvBuildOutcome } from '../hksv/build-outcome.js'
import { describeHksvCamera } from '../hap-export.addon.js'

const CAMERA = { mapperKind: 'camera' as const }

describe('describeHksvCamera — the two authorities, and nothing else', () => {
  it('has no source for a device that was never exposed to HomeKit', () => {
    const facts = describeHksvCamera(null, null, true)
    expect(facts.exported).toBe(false)
  })

  it('has no source for an exposed device that is not a camera', () => {
    const facts = describeHksvCamera({ mapperKind: 'generic' }, null, true)
    expect(facts.exported).toBe(false)
  })

  it('is exported, and keeps copies, for an entry persisted before either field existed', () => {
    // `resolveKeepHomekitClips` is ON when absent: it governs whether we KEEP
    // a copy of what we are already sending, so absence costs nothing and
    // losing it loses footage. There is no recording preference to resolve any
    // more — that answer belongs to HomeKit (D589).
    const facts = describeHksvCamera(CAMERA, null, true)
    expect(facts.exported).toBe(true)
    expect(facts.homekitRecording).toBe(true)
    expect(facts.keepingClips).toBe(true)
  })

  it('reports HomeKit switching recording off, without pretending we did it', () => {
    const facts = describeHksvCamera(CAMERA, null, false)
    expect(facts.exported).toBe(true)
    expect(facts.homekitRecording).toBe(false)
  })

  it('follows the per-camera COPIES switch without hiding the source', () => {
    // The claim is about the COPIES switch alone: turning copies off must not
    // read as "not recording".
    const facts = describeHksvCamera(
      { ...CAMERA, settings: { streamPreference: 'auto', keepClips: false } },
      null,
      true,
    )
    expect(facts.exported).toBe(true)
    expect(facts.homekitRecording).toBe(true)
    expect(facts.keepingClips).toBe(false)
  })

  it('carries the build verdict through untouched', () => {
    const outcome: HksvBuildOutcome = {
      deviceId: 101,
      advertised: false,
      withheld: 'key-frame-interval',
      detail: 'gopMs=12000',
      atMs: 1,
    }
    expect(describeHksvCamera(CAMERA, outcome, true).lastBuild).toBe(outcome)
  })
})

describe('the manifest', () => {
  it('declares videoclips, or no camera ever binds this source', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const names = declaredCapabilityNames(manifest)
    expect(names).toContain('device-export')
    expect(names).toContain('videoclips')
  })
})

/** Read the addon's declared capability names without trusting any shape. */
function declaredCapabilityNames(manifest: unknown): readonly string[] {
  if (typeof manifest !== 'object' || manifest === null || !('camstack' in manifest)) return []
  const { camstack } = manifest
  if (typeof camstack !== 'object' || camstack === null || !('addons' in camstack)) return []
  const { addons } = camstack
  if (!Array.isArray(addons)) return []
  const names: string[] = []
  for (const addon of addons) {
    if (typeof addon !== 'object' || addon === null || !('capabilities' in addon)) continue
    const { capabilities } = addon
    if (!Array.isArray(capabilities)) continue
    for (const capability of capabilities) {
      if (typeof capability !== 'object' || capability === null || !('name' in capability)) continue
      const { name } = capability
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}
