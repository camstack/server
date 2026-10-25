/**
 * Pure seam for `$agent.stageDevUploads` — fetch a hub-staged pack of
 * `dev-uploads/<version>/` and write it under this node's server-root.
 */
import { createHash } from 'node:crypto'
import type { AddonDeploySource } from '@camstack/system'
import { unpackDevUploadVersionBundle } from '../api/dev-uploads-bundle.js'
import { isDevChannelVersion, serverRootDir } from '../server-root/index.js'

export interface StageDevUploadsSeam {
  readonly dataDir: string
  fetchBundle: (s: Extract<AddonDeploySource, { kind: 'hub-http' }>) => Promise<Buffer>
  unpack: typeof unpackDevUploadVersionBundle
}

export interface StageDevUploadsParams {
  readonly version: string
  readonly source: Extract<AddonDeploySource, { kind: 'hub-http' }>
}

export interface StageDevUploadsResult {
  readonly success: true
  readonly version: string
  readonly path: string
  readonly packageCount: number
  readonly appliedSha256: string
}

export async function applyStageDevUploads(
  seam: StageDevUploadsSeam,
  params: StageDevUploadsParams,
): Promise<StageDevUploadsResult> {
  const { version, source } = params
  if (!isDevChannelVersion(version)) {
    throw new Error(`$agent.stageDevUploads: version "${version}" is not dev-channel shaped`)
  }
  const bundle = await seam.fetchBundle(source)
  const appliedSha256 = createHash('sha256').update(bundle).digest('hex')
  const unpacked = await seam.unpack({
    serverRoot: serverRootDir(seam.dataDir),
    version,
    bundle,
  })
  return {
    success: true,
    version,
    path: unpacked.versionDir,
    packageCount: unpacked.packageCount,
    appliedSha256,
  }
}
