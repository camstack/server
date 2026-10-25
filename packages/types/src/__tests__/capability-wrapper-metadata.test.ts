// packages/types/src/__tests__/capability-wrapper-metadata.test.ts
import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../generated/capability-router-map.js'

/**
 * D4 — the cap definition is the single source of truth for wrapper
 * behaviour. Exactly these caps are wrappers, and each declares its
 * auto-bind policy EXPLICITLY here. This test locks that set:
 * adding/removing a wrapper (or flipping its policy) means consciously
 * updating this map.
 *
 * `defaultActive: false` is a legitimate policy — the emulated autotrack,
 * which MOVES the camera, must NEVER auto-bind.
 * Framework wrappers that are useful on every camera auto-bind; anything that
 * acts on the physical world does not.
 */
const WRAPPER_CAPS: Readonly<Record<string, boolean>> = {
  'detection-pipeline': true,
  'motion-detection': true,
  'audio-analysis': true,
  'camera-streams': true,
  'webrtc-session': true,
  'pipeline-analytics': true,
  snapshot: true,
  'camera-pipeline-config': true,
  videoclips: true,
  // `recording` joined the wrappers on 2026-09-24 (D625) with the same
  // policy and for the same reason as `videoclips`: recorded coverage is a
  // property of every camera, the sources are listed beside each other, and
  // the auto-bind is what makes a camera's sources its BINDINGS.
  recording: true,
  'scene-monitor': true,
  // `device-extension` (D648): the contract whose providers are the slot
  // OWNERS of each camera. Same policy as `videoclips`: every owner is a
  // source of every camera it applies to, derived, persisted nowhere.
  'device-extension': true,
  // The EMULATED autotrack (`@camstack/system`'s `autotrack` builtin) drives a
  // real head with `ptz.move` pulses, so
  // it must never auto-bind onto every camera with a cap — the operator binds
  // it where they want it, then uses the cap's own switch. A camera whose
  // firmware has autotrack keeps serving this cap from its NATIVE provider;
  // the wrapper is the second implementation, never a second switch (D520).
  'ptz-autotrack': false,
}

describe('capability wrapper metadata (D4)', () => {
  it('exactly the known wrapper caps declare kind: wrapper', () => {
    const actual = ALL_CAPABILITY_DEFINITIONS.filter((c) => c.kind === 'wrapper')
      .map((c) => c.name)
      .toSorted()
    expect(actual).toEqual(Object.keys(WRAPPER_CAPS).toSorted())
  })

  it('every wrapper cap declares exactly its locked defaultActive policy', () => {
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      if (def.kind === 'wrapper') {
        expect(def.defaultActive, `${def.name} defaultActive policy`).toBe(WRAPPER_CAPS[def.name])
      }
    }
  })

  it('non-wrapper caps do not declare defaultActive', () => {
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      if (def.kind !== 'wrapper') {
        expect(def.defaultActive, `${def.name} must not set defaultActive`).toBeUndefined()
      }
    }
  })
})
