/**
 * Agent-side model distribution (P2): pull a staged model tarball from the hub
 * and untar it into this node's modelsDir. Factored behind a seam so the
 * fetch/extract/fs effects are injectable in tests.
 */

export interface DistributeModelParams {
  readonly modelId: string
  readonly format: string
  readonly source: {
    readonly url: string
    readonly token: string
    readonly sha256: string
    readonly bytes: number
  }
}

export interface ModelDistributionSeam {
  readonly modelsDir: string
  /** Pull + verify (bytes + sha256) the staged tgz. */
  fetchBundle(source: DistributeModelParams['source']): Promise<Buffer>
  /** Untar the gzip buffer into destDir. */
  extract(tgz: Buffer, destDir: string): Promise<void>
  mkdirp(dir: string): void
}

export interface DistributeModelResult {
  readonly success: true
  readonly modelId: string
  readonly format: string
  readonly path: string
}

export async function applyModelDistribution(
  seam: ModelDistributionSeam,
  params: DistributeModelParams,
): Promise<DistributeModelResult> {
  seam.mkdirp(seam.modelsDir)
  const buffer = await seam.fetchBundle(params.source)
  await seam.extract(buffer, seam.modelsDir)
  return { success: true, modelId: params.modelId, format: params.format, path: seam.modelsDir }
}
