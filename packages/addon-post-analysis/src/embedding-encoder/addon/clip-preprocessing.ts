// CLIP normalization constants (OpenAI CLIP)
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const

/**
 * Preprocess raw RGB buffer for CLIP inference.
 * Resizes (nearest-neighbor for speed), normalizes with CLIP mean/std, outputs NCHW Float32Array.
 * For production use, the caller should use sharp to resize the JPEG to targetW×targetH
 * before calling this with the raw RGB. This function handles normalization + layout.
 */
export function preprocessForClip(
  rgb: Buffer,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  const pixels = targetWidth * targetHeight
  const result = new Float32Array(3 * pixels)

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      // Nearest-neighbor sampling
      const srcX = Math.min(Math.floor((x / targetWidth) * srcWidth), srcWidth - 1)
      const srcY = Math.min(Math.floor((y / targetHeight) * srcHeight), srcHeight - 1)
      const srcIdx = (srcY * srcWidth + srcX) * 3
      const dstIdx = y * targetWidth + x

      for (let c = 0; c < 3; c++) {
        const val = (rgb[srcIdx + c] ?? 0) / 255.0
        result[c * pixels + dstIdx] = (val - CLIP_MEAN[c]!) / CLIP_STD[c]!
      }
    }
  }

  return result
}

/**
 * L2-normalize a vector in-place and return it.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm
  }
  return vec
}
