import { vi } from 'vitest'
import type { NativeCropRequester } from '../../session-decode/session-decode-pump.js'
import type { NativeCropAttempt } from '../../session-decode/video-frame-generator.js'

/** No-op native crop requester for registry / lease specs. */
export function mkNativeCropRequester(): NativeCropRequester & {
  release: ReturnType<typeof vi.fn>
  cutTiles: ReturnType<typeof vi.fn>
  markInferred: ReturnType<typeof vi.fn>
} {
  const crop = vi.fn(
    async (): Promise<NativeCropAttempt> => ({
      kind: 'crop',
      crop: { bytes: new Uint8Array([1]), width: 1, height: 1 },
    }),
  )
  return Object.assign(crop, {
    release: vi.fn(),
    cutTiles: vi.fn(),
    markInferred: vi.fn(),
  })
}
