/**
 * Import+land registers a custom model then downloads on the same tick.
 * A warm empty TTL snapshot must not hide the brand-new id.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CustomModelDescriptor } from '@camstack/types'
import { CUSTOM_MODEL_CATALOG_TTL_MS, CustomModelCatalog } from '../custom-model-catalog.js'

function descriptor(id: string): CustomModelDescriptor {
  return {
    stepId: 'object-detection',
    entry: {
      id,
      name: id,
      description: id,
      formats: {
        tflite: {
          url: `https://example.test/${id}.tflite`,
          sizeMB: 1,
          runtimes: ['python'],
        },
      },
      inputSize: { width: 320, height: 320 },
      labels: [{ id: 'person', name: 'person' }],
    },
  }
}

describe('CustomModelCatalog.refresh({ force })', () => {
  it('bypasses the TTL so a just-registered model is visible immediately', async () => {
    let clock = 1_000
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([] as readonly CustomModelDescriptor[])
      .mockResolvedValueOnce([descriptor('frigate-mobiledet-edgetpu')])

    const api = {
      addons: {
        listCapabilityProviders: {
          query: async () => [{ isActive: true }],
        },
      },
      customModelRegistry: {
        listModels: { query: () => listModels() },
      },
    }

    const catalog = new CustomModelCatalog({ warn: () => undefined }, () => clock)

    await catalog.refresh(api)
    expect(catalog.current().get('object-detection') ?? []).toHaveLength(0)

    clock += 1 // still inside TTL
    await catalog.refresh(api)
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(catalog.current().get('object-detection') ?? []).toHaveLength(0)

    await catalog.refresh(api, { force: true })
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(
      catalog
        .current()
        .get('object-detection')
        ?.map((m) => m.id),
    ).toEqual(['frigate-mobiledet-edgetpu'])

    clock += CUSTOM_MODEL_CATALOG_TTL_MS + 1
    await catalog.refresh(api)
    expect(listModels).toHaveBeenCalledTimes(3)
  })
})
