import type { ModelCatalogEntry } from '@camstack/types'

/** Minimal valid catalog row for step-definition fixtures in specs. */
export function makeModelCatalogEntry(
  patch: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'id' | 'name'>,
): ModelCatalogEntry {
  return {
    description: patch.description ?? 'test model',
    formats: patch.formats ?? { onnx: { url: 'https://example/model.onnx', sizeMB: 1 } },
    inputSize: patch.inputSize ?? { width: 640, height: 640 },
    labels: patch.labels ?? [{ id: '0', name: 'object' }],
    preprocessMode: patch.preprocessMode,
    inputChannels: patch.inputChannels,
    inputLayout: patch.inputLayout,
    inputNormalization: patch.inputNormalization,
    outputProbabilities: patch.outputProbabilities,
    postprocessor: patch.postprocessor,
    legacy: patch.legacy,
    classMap: patch.classMap,
    provider: patch.provider,
    license: patch.license,
    id: patch.id,
    name: patch.name,
  }
}
