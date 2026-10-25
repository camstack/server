/**
 * Package-detection step (Phase 5, design ADDENDUM + DECISION 2026-07-17).
 *
 * A dedicated ROOT-plane parcel detector emitting the model-agnostic `package`
 * class that feeds the existing PackageDropDetector. `rfdetr-package` is the
 * DEFAULT and ONLY entry (operator decision 2026-08-07, superseding
 * yolov8n-package of 2026-07-17: +0.86 vs +0.21 parcel↔doormat margin on 101);
 * `yolov8n-package` has since been deleted. The step is OFF by default
 * (zone-driven, opt-in per camera) and declares the `crop-zone` extractMode.
 */
import { describe, expect, it } from 'vitest'
import { PACKAGE_DETECTION_MODELS } from '../registry/model-catalogs.js'
import {
  ALL_PIPELINE_STEPS,
  getDefaultModelForFormat,
  getStepDefinition,
  resolveModelForFormat,
} from '../registry/step-definitions.js'

describe('pipeline step registry — package-detection', () => {
  it('is registered as a root-plane detector with the rfdetr-package default', () => {
    const ids = ALL_PIPELINE_STEPS.map((s) => s.definition.id)
    expect(ids).toContain('package-detection')

    const def = getStepDefinition('package-detection')
    expect(def.slot).toBe('detector')
    expect(def.postprocessor).toBe('yolo')
    // Root plane — a stationary package never gets a track, so it can't be a
    // crop-roi child; it runs on the root plane.
    expect(def.inputClasses).toBeNull()
    expect(def.outputClasses).toEqual(['package'])
    expect(def.extractMode).toBe('crop-zone')
    expect(def.defaultModelId).toBe('rfdetr-package')
    // Opt-in per camera — never auto-runs cluster-wide.
    expect(def.enabledByDefault).toBe(false)
    expect(def.labels).toEqual(['package'])
  })

  it('carries rfdetr-package alone in the catalog (yolov8n-package is gone)', () => {
    const def = getStepDefinition('package-detection')
    expect(def.models.map((m) => m.id)).toEqual(['rfdetr-package'])
  })

  it('rfdetr-package labels package', () => {
    const rfdetr = PACKAGE_DETECTION_MODELS.find((m) => m.id === 'rfdetr-package')!
    expect(rfdetr.labels).toEqual([{ id: 'package', name: 'Package' }])
  })

  it('rfdetr-package ships all three formats and declares the DETR decode', () => {
    const rfdetr = PACKAGE_DETECTION_MODELS.find((m) => m.id === 'rfdetr-package')!
    expect(Object.keys(rfdetr.formats).toSorted()).toEqual(['coreml', 'onnx', 'openvino'])
    expect(rfdetr.formats.coreml?.isDirectory).toBe(true)
    expect(rfdetr.inputSize).toEqual({ width: 576, height: 576 })
    // DETR-style: square resize + ImageNet norm, matching the export.
    expect(rfdetr.preprocessMode).toBe('resize')
    expect(rfdetr.inputNormalization).toBe('imagenet')
    // Per-MODEL postprocessor override. The STEP's own postprocessor stays
    // `yolo` (the removed yolov8n-package's decode); the `yolo` decoder reads this model's
    // [300,4] + [300,2] output as noise, so the override is what makes the
    // default loadable at all.
    expect(rfdetr.postprocessor).toBe('rfdetr')
    expect(getStepDefinition('package-detection').postprocessor).toBe('yolo')
    // NOT legacy: `legacy` hides an entry from the selectable list entirely,
    // which is what kept this model unchoosable while it was a stub.
    expect(rfdetr.legacy).toBeUndefined()
  })

  it('declares the REAL download sizes — the progress bar divides by sizeMB', () => {
    // Were these still the 30 MB stub estimates, a 115 MB onnx pull would
    // report ~380% (`startDownload` derives totalBytes from sizeMB).
    const rfdetr = PACKAGE_DETECTION_MODELS.find((m) => m.id === 'rfdetr-package')!
    expect(rfdetr.formats.onnx?.sizeMB).toBe(115)
    expect(rfdetr.formats.openvino?.sizeMB).toBe(58)
    expect(rfdetr.formats.coreml?.sizeMB).toBe(58)
  })

  it('resolves rfdetr-package on EVERY format a node in the fleet runs', () => {
    // The 2026-08-07 default only holds because rfdetr has a build for each of
    // these: `getDefaultModelForFormat` returns `defaultModelId` ONLY when that
    // model has a `format` build, otherwise it falls through to the
    // smallest-by-size auto-pick.
    expect(getDefaultModelForFormat('package-detection', 'onnx')).toBe('rfdetr-package')
    expect(getDefaultModelForFormat('package-detection', 'openvino')).toBe('rfdetr-package')
    expect(getDefaultModelForFormat('package-detection', 'coreml')).toBe('rfdetr-package')
  })

  it('honors an explicit rfdetr-package pin, and passes a deleted yolov8n-package pin through as custom', () => {
    for (const format of ['onnx', 'openvino', 'coreml'] as const) {
      expect(resolveModelForFormat('package-detection', 'yolov8n-package', format)).toBe(
        'yolov8n-package',
      )
      expect(resolveModelForFormat('package-detection', 'rfdetr-package', format)).toBe(
        'rfdetr-package',
      )
    }
  })

  it('tflite is the known GAP — no package model, exactly as before the switch', () => {
    // A DETR head does not compile to the Edge TPU integer op set, and the
    // previous default had no tflite build either. Documented so a future
    // reader does not read this as a regression introduced by the new default.
    for (const m of PACKAGE_DETECTION_MODELS) {
      expect(m.formats.tflite).toBeUndefined()
    }
  })
})
