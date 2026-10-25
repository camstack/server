/**
 * Task 7C RED — pure selectors over the local plugin catalog YOLO catalog.
 *
 * A production change that would fail this test: offering a family outside
 * T/S/M/C, leaving Test+TFLite or Test+OpenVINO-fp32 selectable, resolving
 * an impossible combination, keeping a downstream value after it is no
 * longer in the manifesto, or mapping two complete selections to one id.
 */
import { describe, expect, it } from 'vitest'
import { PLUGIN_CATALOG_YOLO_MANIFEST } from '../plugin-catalog/plugin-catalog-yolo-manifest.js'
import {
  applyUniquePluginCatalogDefaults,
  pickPluginCatalogLevel,
  resolvePluginCatalogEntry,
  sanitizePluginCatalogSelection,
  pluginCatalogArtifactTrace,
  pluginCatalogFamilyOptions,
  pluginCatalogFormatOptions,
  pluginCatalogImportBlockedReason,
  pluginCatalogInputSizeKey,
  pluginCatalogPrecisionOptions,
  pluginCatalogVariantOptions,
  type PluginCatalogSelection,
  type PluginCatalogSelectorEntry,
} from '../plugin-catalog/plugin-catalog-catalog-selectors.js'

function entry(
  over: Partial<PluginCatalogSelectorEntry> & Pick<PluginCatalogSelectorEntry, 'id'>,
): PluginCatalogSelectorEntry {
  return {
    family: 'yolov9s',
    variant: 'relu',
    format: 'onnx',
    precision: 'fp32',
    inputSize: { width: 320, height: 320 },
    ...over,
  }
}

/** Compact catalog covering the real manifesto discriminants without 34 rows. */
const FIXTURE: readonly PluginCatalogSelectorEntry[] = [
  entry({ id: 't-relu-coreml', family: 'yolov9t', format: 'coreml', precision: 'fp16' }),
  entry({ id: 't-relu-onnx', family: 'yolov9t', format: 'onnx', precision: 'fp32' }),
  entry({ id: 't-relu-ov-fp32', family: 'yolov9t', format: 'openvino', precision: 'fp32' }),
  entry({ id: 't-relu-ov-int8', family: 'yolov9t', format: 'openvino', precision: 'int8' }),
  entry({
    id: 't-test-coreml',
    family: 'yolov9t',
    variant: 'relu_test',
    format: 'coreml',
    precision: 'fp16',
  }),
  entry({
    id: 't-test-onnx',
    family: 'yolov9t',
    variant: 'relu_test',
    format: 'onnx',
    precision: 'fp32',
  }),
  entry({
    id: 't-test-ov-int8',
    family: 'yolov9t',
    variant: 'relu_test',
    format: 'openvino',
    precision: 'int8',
  }),
  entry({ id: 's-relu-coreml', family: 'yolov9s', format: 'coreml', precision: 'fp16' }),
  entry({ id: 's-relu-onnx', family: 'yolov9s', format: 'onnx', precision: 'fp32' }),
  entry({ id: 's-relu-tflite-f16', family: 'yolov9s', format: 'tflite', precision: 'float16' }),
  entry({ id: 's-relu-tflite-f32', family: 'yolov9s', format: 'tflite', precision: 'float32' }),
  entry({
    id: 's-test-onnx',
    family: 'yolov9s',
    variant: 'relu_test',
    format: 'onnx',
    precision: 'fp32',
  }),
  entry({ id: 'm-relu-onnx', family: 'yolov9m', format: 'onnx', precision: 'fp32' }),
  entry({ id: 'c-relu-onnx', family: 'yolov9c', format: 'onnx', precision: 'fp32' }),
]

describe('pluginCatalogFamilyOptions', () => {
  it('lists only T/S/M/C families that exist in the catalog', () => {
    const options = pluginCatalogFamilyOptions([
      ...FIXTURE,
      entry({ id: 'bogus-n', family: 'yolov9n' as PluginCatalogSelectorEntry['family'] }),
    ])
    expect(options.map((o) => o.value)).toEqual(['yolov9t', 'yolov9s', 'yolov9m', 'yolov9c'])
    expect(options.map((o) => o.label)).toEqual(['T', 'S', 'M', 'C'])
  })

  it('omits a valid family that has no manifesto entries', () => {
    const onlySmall = FIXTURE.filter((row) => row.family === 'yolov9s')
    expect(pluginCatalogFamilyOptions(onlySmall).map((o) => o.value)).toEqual(['yolov9s'])
  })
})

describe('choosing Test removes unsupported format/precision combinations', () => {
  it('drops TFLite and OpenVINO fp32 once Test is selected', () => {
    const testSel: PluginCatalogSelection = { family: 'yolov9t', variant: 'relu_test' }
    expect(pluginCatalogFormatOptions(FIXTURE, testSel).map((o) => o.value)).toEqual([
      'coreml',
      'onnx',
      'openvino',
    ])
    expect(
      pluginCatalogPrecisionOptions(FIXTURE, { ...testSel, format: 'openvino' }).map(
        (o) => o.value,
      ),
    ).toEqual(['int8'])
    expect(pluginCatalogFormatOptions(FIXTURE, testSel).map((o) => o.value)).not.toContain('tflite')
  })

  it('keeps TFLite under Standard for the family that actually ships it', () => {
    const standardS: PluginCatalogSelection = { family: 'yolov9s', variant: 'relu' }
    expect(pluginCatalogFormatOptions(FIXTURE, standardS).map((o) => o.value)).toContain('tflite')
    expect(
      pluginCatalogPrecisionOptions(FIXTURE, { ...standardS, format: 'tflite' }).map(
        (o) => o.value,
      ),
    ).toEqual(['float16', 'float32'])
  })
})

describe('TFLite appears only for its manifesto entries', () => {
  it('never offers TFLite for T/M/C or for Test', () => {
    expect(
      pluginCatalogFormatOptions(FIXTURE, { family: 'yolov9t', variant: 'relu' }).map(
        (o) => o.value,
      ),
    ).not.toContain('tflite')
    expect(
      pluginCatalogFormatOptions(FIXTURE, { family: 'yolov9s', variant: 'relu_test' }).map(
        (o) => o.value,
      ),
    ).not.toContain('tflite')
    expect(
      pluginCatalogFormatOptions(PLUGIN_CATALOG_YOLO_MANIFEST, { family: 'yolov9m' }).map(
        (o) => o.value,
      ),
    ).not.toContain('tflite')
  })

  it('offers TFLite only for the real yolov9s Standard entries on the pinned manifesto', () => {
    const formats = pluginCatalogFormatOptions(PLUGIN_CATALOG_YOLO_MANIFEST, {
      family: 'yolov9s',
      variant: 'relu',
    }).map((o) => o.value)
    expect(formats).toContain('tflite')
    const precisions = pluginCatalogPrecisionOptions(PLUGIN_CATALOG_YOLO_MANIFEST, {
      family: 'yolov9s',
      variant: 'relu',
      format: 'tflite',
    }).map((o) => o.value)
    expect(precisions).toEqual([
      'float16',
      'float32',
      'int8',
      'integer_quant',
      'full_integer_quant',
      'edgetpu',
    ])
  })
})

describe('resolvePluginCatalogEntry', () => {
  it('does not resolve an invalid combination to an entry', () => {
    expect(
      resolvePluginCatalogEntry(FIXTURE, {
        family: 'yolov9t',
        variant: 'relu',
        format: 'tflite',
        precision: 'float16',
        inputSize: '320x320',
      }),
    ).toBeUndefined()
    expect(
      resolvePluginCatalogEntry(FIXTURE, {
        family: 'yolov9s',
        variant: 'relu_test',
        format: 'tflite',
        precision: 'float16',
        inputSize: '320x320',
      }),
    ).toBeUndefined()
    expect(
      resolvePluginCatalogEntry(PLUGIN_CATALOG_YOLO_MANIFEST, {
        family: 'yolov9c',
        variant: 'relu_test',
        format: 'openvino',
        precision: 'fp32',
        inputSize: '320x320',
      }),
    ).toBeUndefined()
  })

  it('resolves a complete valid selection to exactly one manifesto entry', () => {
    const resolved = resolvePluginCatalogEntry(FIXTURE, {
      family: 'yolov9s',
      variant: 'relu',
      format: 'tflite',
      precision: 'float16',
      inputSize: '320x320',
    })
    expect(resolved?.id).toBe('s-relu-tflite-f16')

    const live = resolvePluginCatalogEntry(PLUGIN_CATALOG_YOLO_MANIFEST, {
      family: 'yolov9t',
      variant: 'relu',
      format: 'coreml',
      precision: 'fp16',
      inputSize: '320x320',
    })
    expect(live?.id).toBe('scrypted-yolov9t-relu-coreml')
  })
})

describe('sanitizePluginCatalogSelection — downstream reset', () => {
  it('clears downstream values that the new parent filter makes invalid', () => {
    const before: PluginCatalogSelection = {
      family: 'yolov9s',
      variant: 'relu',
      format: 'tflite',
      precision: 'float16',
      inputSize: '320x320',
    }
    const after = sanitizePluginCatalogSelection(FIXTURE, { ...before, variant: 'relu_test' })
    expect(after.family).toBe('yolov9s')
    expect(after.variant).toBe('relu_test')
    expect(after.format).toBeUndefined()
    expect(after.precision).toBeUndefined()
    expect(after.inputSize).toBe('320x320')
  })

  it('pickPluginCatalogLevel drops every axis below the changed level', () => {
    const next = pickPluginCatalogLevel(
      {
        family: 'yolov9s',
        variant: 'relu',
        format: 'tflite',
        precision: 'float16',
        inputSize: '320x320',
      },
      'variant',
      'relu_test',
    )
    expect(next).toEqual({ family: 'yolov9s', variant: 'relu_test' })
    const sanitized = sanitizePluginCatalogSelection(FIXTURE, next)
    expect(resolvePluginCatalogEntry(FIXTURE, sanitized)).toBeUndefined()
  })
})

describe('pluginCatalogArtifactTrace', () => {
  it('renders the operator-facing family → variant → runtime → precision → input signature', () => {
    expect(
      pluginCatalogArtifactTrace({
        family: 'yolov9s',
        variant: 'relu_test',
        format: 'openvino',
        precision: 'int8',
        inputSize: '320x320',
      }),
    ).toBe('S → Test → OpenVINO → int8 → 320×320')
    expect(pluginCatalogArtifactTrace({ family: 'yolov9t' })).toBe('T → — → — → — → —')
    expect(pluginCatalogInputSizeKey({ width: 320, height: 320 })).toBe('320x320')
  })
})

describe('pluginCatalogImportBlockedReason — drift fail-closed', () => {
  it('blocks missing and size-changed with an operator reason', () => {
    expect(pluginCatalogImportBlockedReason({ driftStatus: 'missing', imported: false })).toMatch(
      /missing/i,
    )
    expect(
      pluginCatalogImportBlockedReason({ driftStatus: 'size-changed', imported: false }),
    ).toMatch(/size/i)
  })

  it('blocks imported artifacts and unknown/unavailable drift', () => {
    expect(pluginCatalogImportBlockedReason({ driftStatus: 'ok', imported: true })).toMatch(
      /imported/i,
    )
    expect(
      pluginCatalogImportBlockedReason({ driftStatus: 'unavailable', imported: false }),
    ).toMatch(/unavailable|verified/i)
    expect(
      pluginCatalogImportBlockedReason({ driftStatus: 'totally-new', imported: false }),
    ).toBeTruthy()
    expect(pluginCatalogImportBlockedReason({ driftStatus: 'OK', imported: false })).toBeTruthy()
    expect(pluginCatalogImportBlockedReason({ imported: false })).toBeTruthy()
  })

  it('allows import only for an explicit ok drift that is not already imported', () => {
    expect(pluginCatalogImportBlockedReason({ driftStatus: 'ok', imported: false })).toBeUndefined()
  })

  it('allows import when Library registry is unknown (upsert is safe)', () => {
    expect(
      pluginCatalogImportBlockedReason({
        driftStatus: 'ok',
        imported: false,
        registryKnown: false,
      }),
    ).toBeUndefined()
  })
})

describe('applyUniquePluginCatalogDefaults — no stale combo', () => {
  it('does not keep a TFLite selection after switching to Test', () => {
    const next = applyUniquePluginCatalogDefaults(
      FIXTURE,
      pickPluginCatalogLevel(
        {
          family: 'yolov9s',
          variant: 'relu',
          format: 'tflite',
          precision: 'float16',
          inputSize: '320x320',
        },
        'variant',
        'relu_test',
      ),
    )
    expect(next.format).not.toBe('tflite')
    expect(next.precision).not.toBe('float16')
    const resolved = resolvePluginCatalogEntry(FIXTURE, next)
    expect(resolved?.id).toBe('s-test-onnx')
    expect(resolved?.variant).toBe('relu_test')
  })
})

describe('variant labels stay operator-facing', () => {
  it('offers Standard and Test, never raw relu tokens, and only when present', () => {
    const forT = pluginCatalogVariantOptions(FIXTURE, { family: 'yolov9t' })
    expect(forT).toEqual([
      { value: 'relu', label: 'Standard' },
      { value: 'relu_test', label: 'Test' },
    ])
    const forC = pluginCatalogVariantOptions(FIXTURE, { family: 'yolov9c' })
    expect(forC.map((o) => o.value)).toEqual(['relu'])
  })
})
