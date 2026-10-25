/**
 * The cluster model row, as the operator sees and stores it.
 *
 * Two properties matter here and neither is cosmetic:
 *
 *  1. the defaults rendered are the models running today, so opening the form
 *     and pressing Save cannot change what the cluster embeds with;
 *  2. the choices are a closed set taken from the catalog. A free-text field
 *     would look friendlier and would turn a typo into a cluster-wide refusal
 *     with no bad value anywhere on screen.
 */
import { describe, expect, it } from 'vitest'
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  clusterModelSettingKey,
  CLUSTER_STEP_SETTING_FIELDS,
  clusterStepSettingKey,
  DEFAULT_CLUSTER_STEP_MODELS,
} from '@camstack/types'
import { buildGlobalSettingsSections, CLUSTER_MODEL_SECTION_ID } from '../settings-ui-schemas.js'

const sections = () => buildGlobalSettingsSections({ fpsMinThresholdDefault: 0 })

const section = () => {
  const found = sections().find((s) => s.id === CLUSTER_MODEL_SECTION_ID)
  expect(found, `no "${CLUSTER_MODEL_SECTION_ID}" section in the orchestrator schema`).toBeDefined()
  return found!
}

const field = (key: string): Record<string, unknown> => {
  const found = section().fields.find((f) => f.key === key)
  expect(found, `no "${key}" field in the cluster model section`).toBeDefined()
  return found as unknown as Record<string, unknown>
}

describe('cluster model settings section', () => {
  it('lives on the pipeline tab and has one field per cluster-scoped step', () => {
    expect(section().tab).toBe('pipeline')
    expect(section().fields.map((f) => f.key)).toEqual([
      ...CLUSTER_MODEL_SCOPED_STEPS.map((s) => clusterModelSettingKey(s.stepId)),
      ...CLUSTER_STEP_SETTING_FIELDS.map((f) => clusterStepSettingKey(f.stepId, f.key)),
    ])
  })

  it('defaults to what the cluster runs TODAY — opening the form changes nothing', () => {
    for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
      expect(field(clusterModelSettingKey(step.stepId))['default']).toBe(
        DEFAULT_CLUSTER_STEP_MODELS[step.stepId],
      )
    }
  })

  it('offers a CLOSED set of catalog models, never free text', () => {
    for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
      const f = field(clusterModelSettingKey(step.stepId))
      expect(f['type']).toBe('select')
      expect(f['options']).toEqual(step.options.map((o) => ({ value: o.id, label: o.label })))
    }
  })

  it('is CLUSTER-wide: no field is marked perNode', () => {
    // `perNode: true` is what makes `addon-settings` project a per-node value.
    // One of these on this section would put two encoders in one index, which
    // is the entire defect the scope exists to prevent — and it would look like
    // a one-word improvement in review.
    for (const f of section().fields) {
      expect(f).not.toHaveProperty('perNode')
    }
  })

  it('the default is one of the offered options', () => {
    for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
      expect(step.options.map((o) => o.id)).toContain(step.defaultModelId)
    }
  })

  it('declares cluster step knobs next to the model selects, with catalog defaults', () => {
    for (const f of CLUSTER_STEP_SETTING_FIELDS) {
      const row = field(clusterStepSettingKey(f.stepId, f.key))
      expect(row['type']).toBe('slider')
      expect(row['default']).toBe(f.default)
      expect(row['min']).toBe(f.min)
      expect(row['max']).toBe(f.max)
    }
  })
})
