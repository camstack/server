/**
 * `FrameViewSpec` and `FrameRef` are DERIVED from their wire schemas
 * (`FrameViewSpecSchema` / `FrameRefSchema`) in `capabilities/pipeline-executor.cap.ts`
 * — that is where the schema and the type both live, so re-export rather than
 * redeclare here. See the schema-type-twin guard
 * (`scripts/check-schema-type-twins.ts`): a hand-written duplicate of a Zod
 * shape drifts silently and strips fields on the wire.
 */
export type { FrameRef, FrameViewSpec } from '../capabilities/pipeline-executor.cap.js'
import type { FrameViewSpec } from '../capabilities/pipeline-executor.cap.js'

export interface FrameViewCrop {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface FrameViewGeometry {
  readonly source: { readonly width: number; readonly height: number }
  readonly sourceCrop: FrameViewCrop
  readonly output: { readonly width: number; readonly height: number }
  readonly scale: { readonly x: number; readonly y: number }
}

export interface MaterializedFrameView {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly format: FrameViewSpec['format']
  readonly geometry: FrameViewGeometry
}
