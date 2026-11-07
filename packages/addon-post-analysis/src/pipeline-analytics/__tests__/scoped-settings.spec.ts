/**
 * D986 M4: the analytics form is declared by scoped hooks on the capabilities this addon provides,
 * not by one `globalSettingsSchema()`. The face section is the cluster form of `face-gallery`; the
 * cluster-wide knobs are the cluster form of `pipeline-analytics`; the knobs a camera can override
 * are the fleet defaults of `pipeline-analytics`. One key lives in exactly one scope.
 */
import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
import { buildGlobalSettingsSchema } from '../settings-schema.js'

class Probe extends PipelineAnalyticsAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

describe('the analytics scoped settings', () => {
  const addon = new Probe()

  it('names both capabilities up front', () => {
    expect(addon.caps()).toEqual(expect.arrayContaining(['pipeline-analytics', 'face-gallery']))
  })

  it('the face switch and the face tuning are the cluster form of face-gallery', async () => {
    const face = await addon.getScopedSettingsSchema('cluster', 'face-gallery')
    expect(face?.sections.map((section) => section.id)).toEqual(['face-recognition'])
    expect(keysOf(face)).toContain('faceRecognitionEnabled')
    expect(keysOf(face)).toContain('similarityThreshold')
    expect(await addon.getScopedSettingsSchema('node', 'face-gallery')).toBeNull()
    expect(await addon.getScopedSettingsSchema('device-defaults', 'face-gallery')).toBeNull()
  })

  it('the parked-object switch is a fleet default of pipeline-analytics, not cluster', async () => {
    const defaults = keysOf(
      await addon.getScopedSettingsSchema('device-defaults', 'pipeline-analytics'),
    )
    const cluster = keysOf(await addon.getScopedSettingsSchema('cluster', 'pipeline-analytics'))
    expect(defaults).toContain('stationarySuppressionEnabled')
    expect(cluster).toContain('postProcessingNodeId')
    expect(cluster).not.toContain('stationarySuppressionEnabled')
    expect(await addon.getScopedSettingsSchema('node', 'pipeline-analytics')).toBeNull()
  })

  it('trackingTape is per-camera only: the fleet-default form never carries it (a click there would arm every camera)', async () => {
    const defaults = keysOf(
      await addon.getScopedSettingsSchema('device-defaults', 'pipeline-analytics'),
    )
    expect(defaults).not.toContain('trackingTape')
    expect(defaults).toContain('stationarySuppressionEnabled')
  })

  it('declares every field of the legacy form once, in one scope, and nothing else', async () => {
    const declared = [
      ...keysOf(await addon.getScopedSettingsSchema('cluster', 'face-gallery')),
      ...keysOf(await addon.getScopedSettingsSchema('cluster', 'pipeline-analytics')),
      ...keysOf(await addon.getScopedSettingsSchema('device-defaults', 'pipeline-analytics')),
    ].sort()
    expect(new Set(declared).size).toBe(declared.length)
    expect(declared).toEqual(
      keysOf(buildGlobalSettingsSchema()).filter((key) => key !== 'trackingTape'),
    )
  })

  it('declares nothing for a capability it does not provide', async () => {
    expect(await addon.getScopedSettingsSchema('cluster', 'network-access')).toBeNull()
    expect(await addon.getScopedSettingsSchema('device-defaults', 'network-access')).toBeNull()
  })
})
