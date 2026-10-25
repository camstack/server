/**
 * Regression test for PTZ switch naming.
 *
 * The 8 PTZ switches (presets + 4 directionals + autotrack) used to build
 * their HomeKit service name as `${displayName} — <action>` (EM-DASH
 * U+2014 + a redundant camera-name prefix). HAP-NodeJS rejects the em-dash
 * as an invalid `Name` characteristic, so iOS Home discarded the name and
 * showed generic "Interruttore N".
 *
 * These tests pin the labels themselves: bare, em-dash-free, HAP-valid,
 * no camera prefix. `ptz.ts` qualifies each with the camera name and
 * publishes it through `applyServiceLabel`; that wiring is asserted in
 * `mappers/builders/__tests__/service-naming.spec.ts`.
 */
import { describe, expect, it } from 'vitest'

import {
  PTZ_AUTOTRACK_LABEL,
  PTZ_DIRECTIONS,
  ptzPresetLabel,
} from '../mappers/builders/ptz-labels.js'

const EM_DASH = '—'
// HAP-NodeJS requires a Name that starts and ends with a letter or number.
const HAP_NAME_RE = /^[A-Za-z0-9].*[A-Za-z0-9]$/

function allLabels(): string[] {
  return [
    ptzPresetLabel('stanza'),
    ptzPresetLabel('letto'),
    ptzPresetLabel('dave'),
    ...PTZ_DIRECTIONS.map((d) => d.label),
    PTZ_AUTOTRACK_LABEL,
  ]
}

describe('PTZ switch labels', () => {
  it('every label is em-dash-free and HAP-Name-valid', () => {
    for (const label of allLabels()) {
      expect(label.includes(EM_DASH), `"${label}" contains an em-dash`).toBe(false)
      expect(label, `"${label}" is not a valid HAP Name`).toMatch(HAP_NAME_RE)
    }
  })

  it('no label carries the camera-name prefix', () => {
    for (const label of allLabels()) {
      expect(label).not.toContain('Camera')
      expect(label).not.toMatch(/\s[-–—]\s/) // no " - " / en/em dash separators
    }
  })

  it('exposes the expected bare labels', () => {
    expect(ptzPresetLabel('stanza')).toBe('Preset stanza')
    expect(PTZ_DIRECTIONS.map((d) => d.label)).toEqual([
      'Pan Left',
      'Pan Right',
      'Tilt Up',
      'Tilt Down',
    ])
    expect(PTZ_AUTOTRACK_LABEL).toBe('Autotrack')
  })

  it('keeps stable HAP subtypes for the directional pad', () => {
    expect(PTZ_DIRECTIONS.map((d) => d.subtype)).toEqual([
      'ptz-pan-left',
      'ptz-pan-right',
      'ptz-tilt-up',
      'ptz-tilt-down',
    ])
  })
})
