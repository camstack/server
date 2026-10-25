import type { FrameInput, FrameRef } from '@camstack/types'

export type ExecutorFrameSource = { readonly frameRef: FrameRef } | { readonly frame: FrameInput }

/** A local ref never leaves the grouped process; inline remains rollback/split compatibility. */
export function selectExecutorFrameSource(
  coLocated: boolean,
  frameRef: FrameRef | undefined,
  inlineFrame: FrameInput,
): ExecutorFrameSource {
  return coLocated && frameRef ? { frameRef } : { frame: inlineFrame }
}
