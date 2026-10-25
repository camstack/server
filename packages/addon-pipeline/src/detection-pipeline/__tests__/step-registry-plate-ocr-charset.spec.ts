/**
 * plate-ocr reader contract — WHICH reader is the default, and what pixels it gets.
 *
 * The step hosts two recognizers that fail in opposite directions, so the two
 * halves of this file lock two different things.
 *
 * `cct-s-v2-global` (DEFAULT since 2026-08-20) is a plate reader: fixed-slot
 * decode, no CTC blank, gated on per-character confidence. It reads 19 of the 21
 * ground-truthed cam-102 plates where the incumbent read 4, with the same zero
 * false positives on the 18 junk ROIs — and it reads all seven crops of the car
 * the operator reported (DN-RO 309), which the incumbent got wrong on every
 * frame. That decision is asserted here, not implied: a default that drifts back
 * silently is a 4/21 regression nobody notices until someone re-audits.
 *
 * `vgg_english_g2` left the catalog, but the step's charset calibration stays locked.
 * The plugin catalog export has a 96-character set (97 classes incl. the CTC blank) —
 * one more symbol than the stock EasyOCR latin set — so every A–Z/a–z sits one
 * index too low without a padding slot and the recognizer reads "DWRO309" as
 * "EXSP…" (commit fe5f34b4c). A silent charset edit systematically corrupts
 * every plate that model reads.
 */
import { describe, expect, it } from 'vitest'
import { resolvePlateOcrCropPolicy } from '../pipeline/plate-ocr-crop-policy.js'
import { resolveEffectivePostprocessor } from '../registry/effective-postprocessor.js'
import { getStepDefinition } from '../registry/step-definitions.js'

describe('pipeline step registry — plate-ocr reader', () => {
  const def = getStepDefinition('plate-ocr')
  const models = def.models

  it('defaults to the dedicated plate reader, not the generic text recognizer', () => {
    expect(def.defaultModelId).toBe('cct-s-v2-global')
  })

  it('decodes the default model with the fixed-slot postprocessor', () => {
    const model = models.find((m) => m.id === 'cct-s-v2-global')
    expect(model?.postprocessor).toBe('plate-slots')
  })

  it('declares the weights licence of the default model', () => {
    // The catalog's `license` is a claim we have to be able to defend: MIT,
    // because the ONNX is a release asset of the MIT-licensed upstream repo.
    expect(models.find((m) => m.id === 'cct-s-v2-global')?.license?.weights).toBe('MIT')
  })

  it('feeds the default model 128x64 RGB NHWC, stretched (not letterboxed)', () => {
    const model = models.find((m) => m.id === 'cct-s-v2-global')
    expect(model?.inputSize).toEqual({ width: 128, height: 64 })
    expect(model?.inputLayout).toBe('nhwc')
    expect(model?.preprocessMode).toBe('resize')
    // NOT `inputChannels: 1` — that selects the grayscale EasyOCR preprocess.
    expect(model?.inputChannels).toBeUndefined()
  })

  it('ships all three engine formats for the default model', () => {
    const formats = models.find((m) => m.id === 'cct-s-v2-global')?.formats
    expect(Object.keys(formats ?? {}).sort()).toEqual(['coreml', 'onnx', 'openvino'])
  })

  it('carries the fixed-slot gate to the pool, and keeps the CTC gate too', () => {
    // One step, two readers, two plausibility gates. Each postprocessor ignores
    // the other's knob, so both must be present — dropping either silently
    // reverts that reader to its python-side default.
    expect(def.minCharProbability).toBe(0.75)
    expect(def.minTextLength).toBe(3)
    expect(def.plateRegion).toBe('DE')
  })

  it('gives the two readers OPPOSITE crops', () => {
    const slots = resolvePlateOcrCropPolicy('plate-slots')
    const ctc = resolvePlateOcrCropPolicy('ctc')
    // The plate reader gets the raw detector box plus 5% context (sized for
    // the yolox-tiny-plate box, D719) and NO rectify:
    // the D198 quad-warp exists to rescue a generic text recognizer from a
    // tilted plate's aspect ratio, and it costs this one 15 of its 19 reads.
    expect(slots).toEqual({
      marginFraction: 0.05,
      rectify: false,
      minLongSidePx: 70,
    })
    // The generic recognizer keeps exactly what it had: tight crop, warped.
    expect(ctc).toEqual({
      marginFraction: 0,
      rectify: true,
      minLongSidePx: 85,
    })
  })

  it('resolves the crop policy from the MODEL, not from the step', () => {
    // The step is declared `ctc` and its DEFAULT model overrides that to
    // `plate-slots`. Resolving the policy from `definition.postprocessor` gives
    // the reader quad-warped, 85px-floored pixels while the pool decodes it with
    // the fixed-slot path — the one combination measured at 4/21 instead of
    // 19/21, and it raises no error anywhere. This shipped once; it must not
    // ship twice.
    const effective = resolveEffectivePostprocessor(def, def.defaultModelId)
    expect(effective).toBe('plate-slots')
    expect(resolvePlateOcrCropPolicy(effective)?.rectify).toBe(false)
    expect(resolvePlateOcrCropPolicy(effective)?.marginFraction).toBe(0.05)
  })

  it('still resolves the STEP postprocessor for a model that overrides nothing', () => {
    // An unknown / absent model id must not invent a decode.
    expect(resolveEffectivePostprocessor(def, undefined)).toBe('ctc')
    expect(resolveEffectivePostprocessor(def, 'no-such-model')).toBe('ctc')
  })

  it('applies no plate crop policy to a step that is not a plate reader', () => {
    expect(resolvePlateOcrCropPolicy('arcface')).toBeNull()
    expect(resolvePlateOcrCropPolicy('yolo')).toBeNull()
  })

  it('has dropped vgg-english-g2: cct-s-v2-global is the only entry', () => {
    expect(models.map((m) => m.id)).toEqual(['cct-s-v2-global'])
    expect(models.some((m) => m.id === 'vgg-english-g2')).toBe(false)
    expect(def.postprocessor).toBe('ctc')
  })
})

describe('pipeline step registry — vgg_english_g2 charset calibration', () => {
  const charset = getStepDefinition('plate-ocr').charset ?? []

  it('has 97 classes: 1 blank + 10 digits + 33 symbols + 1 pad + 52 letters', () => {
    expect(charset).toHaveLength(97)
  })

  it('maps index 0 to the CTC blank and 1–10 to the digits', () => {
    expect(charset[0]).toBe('')
    expect(charset.slice(1, 11).join('')).toBe('0123456789')
  })

  it('realigns the letters: the extra pad slot at 44, A at 45, Z at 70, a at 71', () => {
    // This is THE off-by-one calibration. If any of these shift, "DWRO309"
    // reads as "EXSP…"/"CVQN…" again.
    expect(charset[44]).toBe(' ')
    expect(charset[45]).toBe('A')
    expect(charset[48]).toBe('D')
    expect(charset[70]).toBe('Z')
    expect(charset[71]).toBe('a')
    expect(charset[96]).toBe('z')
  })
})
