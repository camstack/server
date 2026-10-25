import { z } from 'zod'
import type {
  ConvertArtifact,
  ConvertResult,
  IModelConvertProvider,
  ModelCatalogEntry,
  ModelConvertInput,
  ModelConvertMetadata,
} from '@camstack/types'
import { ConvertArtifactSchema } from '@camstack/types'

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const ConvertProgressSchema = z.object({
  phase: z.string(),
  pct: z.number().optional(),
  detail: z.string().optional(),
  /** Raw process line (stderr) — UI log pane, not a phase step. */
  log: z.string().optional(),
})
export type ConvertProgress = z.infer<typeof ConvertProgressSchema>

export const ConvertResultLineSchema = z.object({
  result: z.object({
    artifacts: z.array(ConvertArtifactSchema),
  }),
})

// ---------------------------------------------------------------------------
// Deps seam (pure: no direct imports of system/fs/spawn — injected at runtime)
// ---------------------------------------------------------------------------

export interface ModelConvertProviderDeps {
  modelsDir(): Promise<string>
  pythonPath(): Promise<string>
  ensureRequirements(): Promise<void>
  downloadOnnx(url: string, destDir: string, modelId: string): Promise<string>
  writeJob(job: unknown): Promise<string>
  runConvert(
    jobPath: string,
    pythonPath: string,
    onProgress: (p: ConvertProgress) => void,
    sessionId?: string,
  ): Promise<{ artifacts: readonly ConvertArtifact[] }>
  onProgress?(p: ConvertProgress, sessionId?: string): void
}

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------

function buildEntry(
  metadata: ModelConvertMetadata,
  artifacts: readonly ConvertArtifact[],
): ModelCatalogEntry {
  const formats: ModelCatalogEntry['formats'] = {}

  // OpenVINO: group all OV artifacts and pick the best precision (int8 > fp16).
  const ovArtifacts = artifacts
    .filter((a) => a.format === 'openvino')
    .toSorted((a, b) => {
      if (a.precision === 'int8') return -1
      if (b.precision === 'int8') return 1
      return 0
    })

  const bestOv = ovArtifacts[0]
  if (bestOv !== undefined) {
    const xmlFile = bestOv.files.find((f) => f.endsWith('.xml')) ?? bestOv.files[0]
    const binFile = bestOv.files.find((f) => f.endsWith('.bin'))
    if (xmlFile !== undefined) {
      formats.openvino = {
        url: `camstack-local://${metadata.id}/${xmlFile}`,
        sizeMB: bestOv.sizeMB,
        runtimes: ['python'],
        ...(binFile !== undefined ? { files: [binFile] } : {}),
      }
    }
  }

  // CoreML
  const cmArtifact = artifacts.find((a) => a.format === 'coreml')
  if (cmArtifact !== undefined) {
    const pkgFile = cmArtifact.files[0]
    if (pkgFile !== undefined) {
      formats.coreml = {
        url: `camstack-local://${metadata.id}/${pkgFile}`,
        sizeMB: cmArtifact.sizeMB,
        isDirectory: true,
      }
    }
  }

  return {
    id: metadata.id,
    name: metadata.name,
    description: 'Converted via Model Studio P3',
    formats,
    inputSize: metadata.inputSize,
    labels: metadata.labels,
    ...(metadata.inputLayout !== undefined ? { inputLayout: metadata.inputLayout } : {}),
    ...(metadata.inputNormalization !== undefined
      ? { inputNormalization: metadata.inputNormalization }
      : {}),
    ...(metadata.preprocessMode !== undefined ? { preprocessMode: metadata.preprocessMode } : {}),
    ...(metadata.faceAlignment !== undefined ? { faceAlignment: metadata.faceAlignment } : {}),
    ...(metadata.classMap !== undefined ? { classMap: metadata.classMap } : {}),
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function buildModelConvertProvider(deps: ModelConvertProviderDeps): IModelConvertProvider {
  return {
    convert: async (input: ModelConvertInput): Promise<ConvertResult> => {
      await deps.ensureRequirements()
      const dir = await deps.modelsDir()
      const py = await deps.pythonPath()
      const onnxPath = await deps.downloadOnnx(input.sourceUrl, dir, input.metadata.id)
      const jobPath = await deps.writeJob({
        onnxPath,
        outDir: dir,
        modelId: input.metadata.id,
        imgsz: input.metadata.inputSize.width,
        targets: input.targets,
        ...(input.calibrationRef !== undefined ? { calibDir: input.calibrationRef } : {}),
      })
      const { artifacts } = await deps.runConvert(
        jobPath,
        py,
        (p) => {
          deps.onProgress?.(p, input.sessionId)
        },
        input.sessionId,
      )
      return { entry: buildEntry(input.metadata, artifacts), artifacts }
    },
  }
}
