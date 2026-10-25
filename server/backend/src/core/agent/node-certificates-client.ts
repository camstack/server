/**
 * The hub's typed handle on a node's `node-certificates` capability (D856).
 *
 * `createCapabilityProxy` hands back untyped functions; every answer is narrowed
 * through the capability's own Zod output schema, and a missing proxy (node
 * offline, capability not declared by an old agent) or a malformed answer becomes
 * a plain error naming the node - never a cast.
 */
import { nodeCertificatesCapability } from '@camstack/types'
import type { z } from 'zod'
import type { MoleculerService } from '../moleculer/moleculer.service.js'

type Methods = typeof nodeCertificatesCapability.methods
type Output<K extends keyof Methods> = z.infer<Methods[K]['output']>

export interface NodeCertificatesClient {
  getCertificates(): Promise<Output<'getCertificates'>>
  prepareMeshRenewal(): Promise<Output<'prepareMeshRenewal'>>
  installMeshLeaf(input: {
    readonly certPem: string
    readonly caCertPem: string
    readonly confirmWithinMs: number
  }): Promise<Output<'installMeshLeaf'>>
  confirmMeshLeaf(input: { readonly fingerprintSha256: string }): Promise<Output<'confirmMeshLeaf'>>
  rollbackMeshLeaf(): Promise<Output<'rollbackMeshLeaf'>>
  /** Unpair the node (D857): it erases its mesh material and advertises itself again. */
  forgetHub(): Promise<Output<'forgetHub'>>
  prepareHttpsCertificate(): Promise<Output<'prepareHttpsCertificate'>>
  installHttpsCertificate(input: {
    readonly certPem: string
    readonly caCertPem: string
    readonly caRotation?: boolean
  }): Promise<Output<'installHttpsCertificate'>>
}

export function createNodeCertificatesClient(
  moleculer: Pick<MoleculerService, 'createCapabilityProxy'> | null,
  nodeId: string,
): NodeCertificatesClient | null {
  const proxy = moleculer?.createCapabilityProxy('node-certificates', nodeId) ?? null
  if (proxy === null) return null
  const call = async <S extends z.ZodType>(
    method: keyof Methods,
    schema: S,
    params: unknown,
  ): Promise<z.infer<S>> => {
    const fn = proxy[method]
    if (typeof fn !== 'function') {
      throw new Error(
        `node ${nodeId} does not provide node-certificates.${method} (update the agent)`,
      )
    }
    const parsed = schema.safeParse(await fn(params))
    if (!parsed.success) {
      throw new Error(
        `node ${nodeId} answered node-certificates.${method} with an unexpected shape`,
      )
    }
    return parsed.data
  }
  const m = nodeCertificatesCapability.methods
  return {
    getCertificates: () => call('getCertificates', m.getCertificates.output, {}),
    prepareMeshRenewal: () => call('prepareMeshRenewal', m.prepareMeshRenewal.output, {}),
    installMeshLeaf: (input) => call('installMeshLeaf', m.installMeshLeaf.output, input),
    confirmMeshLeaf: (input) => call('confirmMeshLeaf', m.confirmMeshLeaf.output, input),
    rollbackMeshLeaf: () => call('rollbackMeshLeaf', m.rollbackMeshLeaf.output, {}),
    forgetHub: () => call('forgetHub', m.forgetHub.output, {}),
    prepareHttpsCertificate: () =>
      call('prepareHttpsCertificate', m.prepareHttpsCertificate.output, {}),
    installHttpsCertificate: (input) =>
      call('installHttpsCertificate', m.installHttpsCertificate.output, input),
  }
}
