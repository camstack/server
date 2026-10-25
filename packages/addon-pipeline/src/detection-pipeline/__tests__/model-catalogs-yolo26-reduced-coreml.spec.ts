import { describe, it, expect } from 'vitest'
import { OBJECT_DETECTION_MODELS } from '../registry/model-catalogs.js'

// D742 — the batch-flexible YOLO26 @320/@256 CoreML packages aborted the process
// that loaded them (Core ML's gather_nd shape pass, macOS 26.2, every compute
// unit). They were re-exported static (batch 1) and REPLACED IN PLACE on the
// mirror, so the catalog keeps the original file names. That the export is
// static is enforced where it is made: `check_recipes` in
// scripts/build-camstack-models.py refuses a batch-flexible YOLO26 CoreML recipe.
const REDUCED = ['n', 's', 'm', 'l'].flatMap((tier) =>
  [320, 256].map((res) => `yolo26${tier}-${res}`),
)

describe('YOLO26 @320/@256 CoreML packages', () => {
  it.each(REDUCED)('%s keeps its original CoreML file name (replaced in place)', (id) => {
    const entry = OBJECT_DETECTION_MODELS.find((m) => m.id === id)
    expect(entry?.formats.coreml?.url).toMatch(
      new RegExp(`/objectDetection/yolo26/coreml/camstack-${id}\\.mlpackage$`),
    )
  })

  it.each(REDUCED)('%s is a directory bundle fetched file by file', (id) => {
    const coreml = OBJECT_DETECTION_MODELS.find((m) => m.id === id)?.formats.coreml
    expect(coreml?.isDirectory).toBe(true)
    expect(coreml?.files).toContain('Data/com.apple.CoreML/weights/weight.bin')
  })
})
