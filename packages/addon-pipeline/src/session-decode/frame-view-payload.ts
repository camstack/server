export const FRAME_VIEW_PAYLOAD_POLICY = 'jpeg' as const

export interface FrameViewPayloadComparison {
  readonly rawBytes: number
  readonly jpegBytes: number
  readonly payloadsMeasured: 2
  readonly jpegRatio: number
}

export function compareFrameViewPayload(
  width: number,
  height: number,
  jpegBytes: number,
): FrameViewPayloadComparison {
  const rawBytes = width * height * 3
  return {
    rawBytes,
    jpegBytes,
    payloadsMeasured: 2,
    jpegRatio: rawBytes > 0 ? jpegBytes / rawBytes : 1,
  }
}
