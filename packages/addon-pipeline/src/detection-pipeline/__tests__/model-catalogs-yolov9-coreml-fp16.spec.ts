import { describe, expect, it } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- the revision rule is the downloader's (build-time dep, as in provider.ts)
import { resolveFormatRevision } from '@camstack/system/addon-utils'
import { OBJECT_DETECTION_MODELS } from '../registry/model-catalogs.js'

// D743 — the YOLOv9 CoreML packages were FP32, which the Neural Engine cannot
// run (Core ML put them on the GPU). They were re-exported FP16 and REPLACED IN
// PLACE on the mirror: same paths, same file names. A node that already holds
// the FP32 copy learns it is outdated only from the format's revision — the
// downloader keeps any file whose name is already on disk. The revision comes
// from the generated mirror table (D744), and these are the values D743
// shipped by hand: regenerating the table must not have moved them. That the export is
// FP16 is enforced where it is made: `check_recipes` in
// scripts/build-camstack-models.py refuses an FP32 CoreML recipe.
const YOLOV9 = ['t', 's', 'm', 'c'].flatMap((tier) =>
  [320, 640].map((res) => `yolov9${tier}-${res}`),
)

const coremlOf = (id: string) => OBJECT_DETECTION_MODELS.find((m) => m.id === id)?.formats.coreml
const revisionOf = (id: string) => {
  const coreml = coremlOf(id)
  return coreml === undefined ? undefined : resolveFormatRevision(coreml)
}

const D743_REVISIONS: Readonly<Record<string, string>> = {
  'yolov9t-320': '531aa2d14e7e321f2c90219b966cc3781781d0304c7bed7e6c3b75adaa2ada86',
  'yolov9t-640': '53dfec9857b3c9922fcbd5e9f88f34ed79de26d9bbcf0d705a1c7a4e5ac93398',
  'yolov9s-320': '6408badb44161268a337f87586ad82f40e4e315a58be460a648407cc38097675',
  'yolov9s-640': '9f68b8d418b0832e9788f115e2dfabc6ff54fbe5244815adafa0bd9f98204755',
  'yolov9m-320': 'e0e0298051c71c79390f1a05f71a2bb882af52c096c70d69674afb84077f6de4',
  'yolov9m-640': '4c56eef689435b427c53e92e918be386781024c9b77492f9e486dcdd8ea3570c',
  'yolov9c-320': '7999f25b805f92c732a450625021cda97b7185f8c9f98be28be82be1529fe171',
  'yolov9c-640': '9889ababc524db385a4305ebc1a42ada4dddc8028198d040fbba77c504228932',
}

describe('YOLOv9 CoreML packages (FP16, replaced in place)', () => {
  it.each(YOLOV9)('%s keeps its original CoreML file name', (id) => {
    expect(coremlOf(id)?.url).toMatch(
      new RegExp(`/objectDetection/yolov9/coreml/camstack-${id}\\.mlpackage$`),
    )
  })

  it.each(
    YOLOV9,
  )('%s resolves the revision of the FP16 package (sha256 of its weight.bin)', (id) => {
    expect(revisionOf(id)).toBe(D743_REVISIONS[id])
  })

  it('every package has its own revision', () => {
    const revisions = YOLOV9.map((id) => revisionOf(id))
    expect(new Set(revisions).size).toBe(YOLOV9.length)
  })

  it.each(YOLOV9)('%s is about half the size of its FP32 ONNX (FP16 weights)', (id) => {
    const entry = OBJECT_DETECTION_MODELS.find((m) => m.id === id)
    const onnx = entry?.formats.onnx?.sizeMB ?? 0
    const coreml = entry?.formats.coreml?.sizeMB ?? Infinity
    expect(coreml).toBeLessThan(onnx * 0.6)
  })
})
