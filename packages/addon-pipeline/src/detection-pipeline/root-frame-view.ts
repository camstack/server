import type { FrameViewCrop, FrameViewSpec } from '@camstack/types'
import { FRAME_VIEW_PAYLOAD_POLICY } from '../session-decode/frame-view-payload.js'

export interface RootModelView {
  readonly inputSize: { readonly width: number; readonly height: number }
  readonly preprocessMode?: string
}

/** Resolve the pre-padding content requested from the decode worker for one root. */
export function resolveRootFrameViewSpec(
  model: RootModelView,
  source: { readonly width: number; readonly height: number },
  crop?: FrameViewCrop,
  format: FrameViewSpec['format'] = FRAME_VIEW_PAYLOAD_POLICY,
): FrameViewSpec {
  const sourceWidth = crop?.width ?? source.width
  const sourceHeight = crop?.height ?? source.height
  if (model.preprocessMode !== 'letterbox') {
    return {
      ...(crop ? { crop } : {}),
      content: { width: model.inputSize.width, height: model.inputSize.height },
      fit: 'stretch',
      format,
    }
  }
  const scale = Math.min(model.inputSize.width / sourceWidth, model.inputSize.height / sourceHeight)
  return {
    ...(crop ? { crop } : {}),
    content: {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    },
    fit: 'contain',
    format,
  }
}
