/**
 * The Reolink provider answers with the shared envelope, never one of its own
 * (D612). The envelope's own invariants are pinned in
 * `packages/types/src/__tests__/clip-playback-options.spec.ts`, where they run
 * against the SOURCE — this suite resolves `@camstack/types` to the built
 * package, so a gate placed here would pass under its own revert until a
 * rebuild.
 */
import { CLIP_PLAYBACK_OPTIONS } from '@camstack/types'
import { describe, expect, it } from 'vitest'

describe('the Reolink provider answers with the envelope, never one of its own', () => {
  it('returns CLIP_PLAYBACK_OPTIONS.stream for every camera', async () => {
    // Every clip here reaches the player over `dialClipStream`'s forward-only
    // stream, so `stream` is the whole answer — and it is a CONSTANT, because
    // this method is asked per camera and must never cost a camera call.
    const { createReolinkVideoclipsProvider } = await import(
      '../clips/reolink-videoclips-provider.js'
    )
    const provider = createReolinkVideoclipsProvider({} as never)
    const answer = await provider.getPlaybackOptions?.({ deviceId: 107, provider: 'x' })
    expect(answer).toBe(CLIP_PLAYBACK_OPTIONS.stream)
  })
})
