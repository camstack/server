/**
 * The timeline's taxonomy is the CONFIGURED one, not the observed one (D449).
 *
 * `listEventKinds` used to read `getCameraStatus.detection != null`, a runtime
 * fact: an on-motion camera between motion events answered `detection: null`
 * and was described as detecting nothing. These specs pin the derivation on
 * `resolvePipeline` — the configuration — and on `FIRST_LEVEL_MACRO_CLASSES`
 * as the one class authority.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CameraPipelineConfig } from '@camstack/types'
import { FIRST_LEVEL_MACRO_CLASSES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { emittableFromPipelineConfig, NO_EMITTABLE } from '../services/event-kinds-config.js'

type Step = CameraPipelineConfig['steps'][number]

function detector(overrides: Partial<Step> = {}): Step {
  return { addonId: 'object-detection', enabled: true, ...overrides }
}

/** The shape the hub answers for an on-motion camera BETWEEN motion events:
 *  the pipeline is fully configured, and there is no session. */
const ARMED_ON_MOTION: CameraPipelineConfig = {
  steps: [
    detector({
      children: [
        {
          addonId: 'face-detection',
          enabled: true,
          children: [{ addonId: 'face-embedding', enabled: true }],
        },
        { addonId: 'clip-embedding', enabled: true },
      ],
    }),
    { addonId: 'package-detection', enabled: true },
  ],
  audio: { enabled: true },
}

describe('emittableFromPipelineConfig — the taxonomy the camera SUPPORTS', () => {
  it('an armed on-motion camera with no session advertises every first-level macro and audio', () => {
    expect(emittableFromPipelineConfig(ARMED_ON_MOTION)).toEqual({
      macroClasses: [...FIRST_LEVEL_MACRO_CLASSES],
      audioEnabled: true,
    })
  })

  it('the class list IS FIRST_LEVEL_MACRO_CLASSES, never a list built here', () => {
    const { macroClasses } = emittableFromPipelineConfig(ARMED_ON_MOTION)
    expect(macroClasses).toEqual([...FIRST_LEVEL_MACRO_CLASSES])
    expect(macroClasses).not.toContain('package')
  })

  it('an explicit non-empty enabledMacroClasses narrows the offer, in the authority order', () => {
    const config: CameraPipelineConfig = {
      steps: [detector({ settings: { enabledMacroClasses: ['animal', 'person'] } })],
      audio: null,
    }
    expect(emittableFromPipelineConfig(config).macroClasses).toEqual(['person', 'animal'])
  })

  it('an empty enabledMacroClasses means every class (the executor rule)', () => {
    const config: CameraPipelineConfig = {
      steps: [detector({ settings: { enabledMacroClasses: [] } })],
      audio: null,
    }
    expect(emittableFromPipelineConfig(config).macroClasses).toEqual([...FIRST_LEVEL_MACRO_CLASSES])
  })

  it("a stored 'package' on the detector step never advertises the package lane", () => {
    const config: CameraPipelineConfig = {
      steps: [detector({ settings: { enabledMacroClasses: ['person', 'package'] } })],
      audio: null,
    }
    expect(emittableFromPipelineConfig(config).macroClasses).toEqual(['person'])
  })

  it('a detector switched off on this camera advertises no detection class', () => {
    const config: CameraPipelineConfig = {
      steps: [detector({ enabled: false }), { addonId: 'package-detection', enabled: true }],
      audio: { enabled: true },
    }
    expect(emittableFromPipelineConfig(config)).toEqual({ macroClasses: [], audioEnabled: true })
  })

  it('a camera whose detection-pipeline binding is inactive (steps: []) advertises nothing', () => {
    expect(emittableFromPipelineConfig({ steps: [], audio: null })).toEqual(NO_EMITTABLE)
  })

  it('audio follows the configured classifier, not a runtime block', () => {
    expect(
      emittableFromPipelineConfig({ steps: [detector()], audio: { enabled: false } }).audioEnabled,
    ).toBe(false)
    expect(
      emittableFromPipelineConfig({ steps: [detector()], audio: undefined }).audioEnabled,
    ).toBe(false)
  })

  it('finds the detector below the root, so a re-rooted tree is not read as off', () => {
    const config: CameraPipelineConfig = {
      steps: [{ addonId: 'motion-gate', enabled: true, children: [detector()] }],
      audio: null,
    }
    expect(emittableFromPipelineConfig(config).macroClasses).toEqual([...FIRST_LEVEL_MACRO_CLASSES])
  })

  it('listEventKinds and listEventKindsBatch read the configuration, never getCameraStatus', () => {
    // A source guard, because the two methods sit in a 12 000-line class no
    // unit test constructs. Re-introducing the status read is the exact
    // regression this record exists for, and it would be green everywhere else.
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const from = source.indexOf('async listEventKinds(')
    const to = source.indexOf('async getSensorEvents(')
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const body = source.slice(from, to)
    expect(body).not.toContain('getCameraStatus')
    expect(body).toContain('resolvePipeline')
  })
})
