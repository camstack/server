import type { FrameRef, FrameViewGeometry, FrameViewSpec } from '@camstack/types'
import type {
  FrameReleaseReason,
  LocalFrameRegistry,
  LocalFrameLease,
} from '../session-decode/local-frame-registry.js'
import { resolveRootFrameViewSpec, type RootModelView } from './root-frame-view.js'

interface RootLike {
  readonly modelId: string
  readonly definition: {
    readonly models: readonly (RootModelView & { readonly id: string })[]
  }
}

export interface ResolvedRootFrameView {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly format: FrameViewSpec['format']
  readonly geometry: FrameViewGeometry
}

export class LocalFrameRefMissError extends Error {
  constructor(readonly reason: 'foreign-registry' | 'stale-ref' | 'not-acquired') {
    super(`local frameRef miss: ${reason}`)
    this.name = 'LocalFrameRefMissError'
  }
}

export interface RootFrameViewResolver {
  (root: RootLike, crop?: FrameViewSpec['crop']): Promise<ResolvedRootFrameView>
  release(reason: FrameReleaseReason): void
}

/** Bind one registry lease for all heterogeneous roots of a pipeline invocation. */
export function createRootFrameViewResolver(
  registry: LocalFrameRegistry,
  ref: FrameRef,
): RootFrameViewResolver {
  const lease: LocalFrameLease | null = registry.acquire(ref)
  if (!lease) {
    throw new LocalFrameRefMissError(
      ref.registryId === registry.registryId ? 'stale-ref' : 'foreign-registry',
    )
  }
  const resolve = async (
    root: RootLike,
    crop?: FrameViewSpec['crop'],
  ): Promise<ResolvedRootFrameView> => {
    const model = root.definition.models.find((candidate) => candidate.id === root.modelId)
    if (!model) throw new Error(`frame view model not found: ${root.modelId}`)
    const spec = resolveRootFrameViewSpec(model, ref, crop)
    const result = await lease.resolve(spec)
    if (result.kind === 'miss') throw new LocalFrameRefMissError(result.reason)
    return result
  }
  return Object.assign(resolve, {
    release: (reason: FrameReleaseReason): void => lease.release(reason),
  })
}
