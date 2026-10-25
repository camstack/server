/**
 * Variant grouping overlay — folds the flat object-detection catalog into the
 * family → tier → variant tree the selector renders, and maps a grouped
 * selection back to a flat model id. Legacy / ungrouped entries stay out.
 */
import { describe, it, expect } from 'vitest'
import { OBJECT_DETECTION_MODELS } from '../model-catalogs.js'
import {
  buildModelVariantGroups,
  resolveVariantModelId,
  describeModelVariant,
  type ModelVariantSource,
} from '@camstack/types'

describe('buildModelVariantGroups', () => {
  const groups = buildModelVariantGroups(OBJECT_DETECTION_MODELS)

  it('surfaces the YOLO26, YOLO26-seg + our YOLOv9 families (legacy families excluded)', () => {
    expect(groups.map((g) => g.family)).toEqual(['yolo26', 'yolo26-seg', 'yolov9'])
    expect(groups[0]?.label).toBe('YOLO26')
    // The family word as the product spells it. Uppercasing the id produced
    // "YOLOV9", which is a name nothing else in the product uses.
    expect(groups[2]?.label).toBe('YOLOv9')
  })

  it('offers YOLO26-seg as its own family, n/s/m at 640, with its hint (D737)', () => {
    const seg = groups.find((g) => g.family === 'yolo26-seg')!
    expect(seg.label).toBe('YOLO26-seg')
    expect(seg.hint).toBe('detection + masks, slightly heavier')
    expect(seg.tiers.map((t) => t.label)).toEqual(['Nano', 'Small', 'Medium'])
    expect(seg.tiers.map((t) => t.baseModelId)).toEqual([
      'yolo26n-seg',
      'yolo26s-seg',
      'yolo26m-seg',
    ])
    // The plain detector family carries no hint.
    expect(groups[0]?.hint).toBeUndefined()
  })

  it('never names a resolution in a tier label — resolution is a separate axis', () => {
    // The tier card is picked BEFORE the resolution chip, so a size label
    // reading "Tiny @640" is either redundant or, once 320 is selected,
    // actively wrong. Our yolov9 family has no resolution-less build, so its
    // tier labels used to inherit the 640 entry's name verbatim.
    const labelled = groups.flatMap((g) => g.tiers.map((t) => t.label))
    expect(labelled.filter((l) => /\d{3}|@/.test(l))).toEqual([])
  })

  it('orders the yolov9 ladder by size and labels each tier by name alone', () => {
    const yolov9 = groups.find((g) => g.family === 'yolov9')!
    expect(yolov9.tiers.map((t) => t.tier)).toEqual(['t', 's', 'm', 'c'])
    expect(yolov9.tiers.map((t) => t.label)).toEqual(['Tiny', 'Small', 'Medium', 'Compact'])
    // Its canonical build is the largest-input fp32 one.
    expect(yolov9.tiers[0]?.baseModelId).toBe('yolov9t-640')
  })

  it('makes every grouped variant declare its OWN input resolution', () => {
    // An absent resolution is what forced the selector to hardcode
    // "640 · native" and what let a tier fall back to a 640-named base. Each
    // entry states its own, so nothing downstream has to assume a family's
    // native size.
    const missing = groups.flatMap((g) =>
      g.tiers.flatMap((t) =>
        t.options.filter((o) => o.resolution === undefined).map((o) => o.modelId),
      ),
    )
    expect(missing, `options with no declared resolution: ${missing.join(', ')}`).toEqual([])
  })

  it('exposes the n/s/m/l tiers in ladder order with clean labels', () => {
    const yolo26 = groups[0]!
    expect(yolo26.tiers.map((t) => t.tier)).toEqual(['n', 's', 'm', 'l'])
    expect(yolo26.tiers.map((t) => t.label)).toEqual(['Nano', 'Small', 'Medium', 'Large'])
    // No yolo26x — it is legacy.
    expect(yolo26.tiers.some((t) => t.tier === 'x')).toBe(false)
  })

  it('nests Standard + Int8 as native-resolution variants of each tier (standard first)', () => {
    const small = buildModelVariantGroups(OBJECT_DETECTION_MODELS)[0]!.tiers.find(
      (t) => t.tier === 's',
    )!
    expect(small.baseModelId).toBe('yolo26s')
    // The tier's NATIVE-resolution options are the fp32 + int8 nesting.
    const nativeOpts = small.options.filter((o) => o.resolution === 640)
    expect(nativeOpts.map((o) => o.modelId)).toEqual(['yolo26s', 'yolo26s-int8'])
    expect(nativeOpts.map((o) => o.label)).toEqual(['Standard', 'Int8'])
    expect(nativeOpts[0]?.precision).toBe('fp32')
    expect(nativeOpts[1]?.precision).toBe('int8')
    // Base ships all three formats; the int8 variant is openvino-only.
    expect([...nativeOpts[0]!.formats].toSorted()).toEqual(['coreml', 'onnx', 'openvino'])
    expect(nativeOpts[1]?.formats).toEqual(['openvino'])
  })

  it('surfaces reduced-input (320/256) as a resolution axis on each tier', () => {
    const small = buildModelVariantGroups(OBJECT_DETECTION_MODELS)[0]!.tiers.find(
      (t) => t.tier === 's',
    )!
    const resolutions = [...new Set(small.options.map((o) => o.resolution))]
    expect(resolutions).toContain(640) // native
    expect(resolutions).toContain(320)
    expect(resolutions).toContain(256)
    // Each reduced resolution nests its own fp32 + int8.
    const r320 = small.options.filter((o) => o.resolution === 320)
    expect(r320.map((o) => o.modelId).toSorted()).toEqual(['yolo26s-320', 'yolo26s-320-int8'])
  })

  it('excludes legacy fp16 / YOLOv9 / plugin catalog entries entirely', () => {
    const allModelIds = groups.flatMap((g) =>
      g.tiers.flatMap((t) => t.options.map((o) => o.modelId)),
    )
    expect(allModelIds).not.toContain('yolo26s-fp16')
    expect(allModelIds).not.toContain('yolov9s') // legacy bare v9 deleted (our v9 is yolov9s-320 etc.)
    expect(allModelIds.some((id) => id.startsWith('plugin-catalog-'))).toBe(false)
    expect(allModelIds.some((id) => id.startsWith('yolo26x'))).toBe(false)
    // yolo26: 8 native (n/s/m/l × {fp32,int8}) + 16 reduced ({320,256}) = 24.
    // our yolov9: t/s/m/c × {320,640} × {base,int8} = 16 (8 of them 640 = native).
    // yolo26-seg: n/s/m at 640 = 3.
    const native = allModelIds.filter((id) => !/-(320|256)/.test(id))
    expect(native.length).toBe(19)
    expect(allModelIds.length).toBe(43)
  })
})

describe('resolveVariantModelId', () => {
  it('maps a grouped selection to the flat id', () => {
    expect(resolveVariantModelId(OBJECT_DETECTION_MODELS, { family: 'yolo26', tier: 's' })).toBe(
      'yolo26s',
    )
    expect(
      resolveVariantModelId(OBJECT_DETECTION_MODELS, {
        family: 'yolo26',
        tier: 's',
        precision: 'int8',
      }),
    ).toBe('yolo26s-int8')
    expect(
      resolveVariantModelId(OBJECT_DETECTION_MODELS, {
        family: 'yolo26',
        tier: 'l',
        precision: 'fp32',
      }),
    ).toBe('yolo26l')
  })

  it('returns null for a non-existent variant (e.g. int8 of a tier with none)', () => {
    // No yolo26n-test build exists.
    expect(
      resolveVariantModelId(OBJECT_DETECTION_MODELS, {
        family: 'yolo26',
        tier: 'n',
        optimization: 'test',
      }),
    ).toBeNull()
  })
})

describe('describeModelVariant', () => {
  it('describes a flat id as a grouped selection', () => {
    expect(describeModelVariant(OBJECT_DETECTION_MODELS, 'yolo26s-int8')).toEqual({
      family: 'yolo26',
      tier: 's',
      precision: 'int8',
      optimization: 'standard',
      resolution: 640,
    })
    expect(describeModelVariant(OBJECT_DETECTION_MODELS, 'yolo26n')).toEqual({
      family: 'yolo26',
      tier: 'n',
      precision: 'fp32',
      optimization: 'standard',
      resolution: 640,
    })
  })

  it('returns null for a legacy / ungrouped / unknown id', () => {
    expect(describeModelVariant(OBJECT_DETECTION_MODELS, 'yolov9s')).toBeNull()
    expect(describeModelVariant(OBJECT_DETECTION_MODELS, 'nonexistent')).toBeNull()
  })
})

describe('grouping the REDUCED PipelineModelOption shape', () => {
  // The pipeline/device steppers feed the selector the reduced `getSchema`
  // model shape (`{ id, name, formats: { <fmt>: { downloaded, sizeMB } }, group,
  // legacy }`), NOT the full `ModelCatalogEntry`. The helpers are typed on the
  // structural `ModelVariantSource`, so this proves the same grouped picker
  // works there — the whole point of enriching `PipelineModelOptionSchema`.
  const reduced: readonly ModelVariantSource[] = OBJECT_DETECTION_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    legacy: m.legacy,
    group: m.group,
    formats: Object.fromEntries(
      Object.entries(m.formats)
        .filter(([, entry]) => entry !== undefined)
        .map(([f, entry]) => [f, { sizeMB: entry!.sizeMB }]),
    ),
  }))

  it('folds identically to the full catalog', () => {
    const full = buildModelVariantGroups(OBJECT_DETECTION_MODELS)
    const fromReduced = buildModelVariantGroups(reduced)
    expect(fromReduced.map((f) => f.family)).toEqual(full.map((f) => f.family))
    const smallFull = full[0]!.tiers.find((t) => t.tier === 's')!
    const smallReduced = fromReduced[0]!.tiers.find((t) => t.tier === 's')!
    expect(smallReduced.baseModelId).toBe(smallFull.baseModelId)
    expect(smallReduced.options.map((o) => o.modelId)).toEqual(
      smallFull.options.map((o) => o.modelId),
    )
    expect([...smallReduced.options[0]!.formats].toSorted()).toEqual(['coreml', 'onnx', 'openvino'])
  })

  it('resolves + describes on the reduced shape', () => {
    expect(resolveVariantModelId(reduced, { family: 'yolo26', tier: 's', precision: 'int8' })).toBe(
      'yolo26s-int8',
    )
    expect(describeModelVariant(reduced, 'yolo26n')).toEqual({
      family: 'yolo26',
      tier: 'n',
      precision: 'fp32',
      optimization: 'standard',
      resolution: 640,
    })
  })

  it('still excludes legacy entries from the reduced shape', () => {
    const ids = buildModelVariantGroups(reduced).flatMap((g) =>
      g.tiers.flatMap((t) => t.options.map((o) => o.modelId)),
    )
    expect(ids).not.toContain('yolov9s')
    // yolo26 (8 native + 16 reduced = 24) + our yolov9 (t/s/m/c × {320,640} × {base,int8} = 16)
    // + yolo26-seg (n/s/m = 3).
    expect(ids.length).toBe(43)
  })

  it('resolves + describes a reduced-input variant by resolution', () => {
    expect(resolveVariantModelId(reduced, { family: 'yolo26', tier: 'n', resolution: 320 })).toBe(
      'yolo26n-320',
    )
    expect(
      resolveVariantModelId(reduced, {
        family: 'yolo26',
        tier: 'n',
        precision: 'int8',
        resolution: 256,
      }),
    ).toBe('yolo26n-256-int8')
    // An OMITTED resolution still means "the native build" — the largest input
    // the tier ships — so a caller that does not care keeps working.
    expect(resolveVariantModelId(reduced, { family: 'yolo26', tier: 'n' })).toBe('yolo26n')
    expect(resolveVariantModelId(reduced, { family: 'yolo26', tier: 'n', resolution: 640 })).toBe(
      'yolo26n',
    )
    expect(describeModelVariant(reduced, 'yolo26s-320')).toEqual({
      family: 'yolo26',
      tier: 's',
      precision: 'fp32',
      optimization: 'standard',
      resolution: 320,
    })
  })
})
