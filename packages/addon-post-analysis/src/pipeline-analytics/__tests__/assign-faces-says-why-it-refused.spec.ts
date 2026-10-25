/**
 * A batch assign that refuses a face says WHY.
 *
 * `assignFaces` walks the ids and collects per-face failures instead of
 * aborting the rest — which is right — but it collected them like this:
 *
 * ```ts
 * } catch {
 *   failed.push(faceId)
 * }
 * ```
 *
 * The id survived and the reason did not. On 2026-09-10 the operator hit
 * "impossibile assegnare una faccia" repeatedly; the viewer had just been
 * taught to report `{ asked: 1, failed: 1, failedIds: [...] }`, which proved
 * the hub had ANSWERED and refused that specific face — and then the trail
 * ended, because the hub had discarded the only thing left to know. The faces
 * were present in the gallery, so it was not the one refusal `assignFace`
 * names out loud (`face not found`); it threw somewhere deeper, in the
 * enrolment or media path.
 *
 * The rule is the repo's own: a branch that drops work logs it. Collecting a
 * failure is dropping work.
 */
import { describe, expect, it } from 'vitest'
import { FaceGalleryProvider } from '../face-gallery-provider'

interface Line {
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

function recordingLogger(into: Line[]) {
  const push =
    () =>
    (message: string, arg?: { meta?: Record<string, unknown> }): undefined => {
      into.push({ message, meta: arg?.meta })
      return undefined
    }
  const self = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => self,
    withTags: () => self,
  }
  return self
}

/** A provider whose single-face assign always throws a NAMED error. */
function providerThatRefuses(lines: Line[], boom: Error): FaceGalleryProvider {
  const provider = Object.create(FaceGalleryProvider.prototype) as FaceGalleryProvider
  Object.defineProperty(provider, 'logger', { value: recordingLogger(lines), writable: true })
  Object.defineProperty(provider, 'assignFace', {
    value: async () => {
      throw boom
    },
    writable: true,
  })
  return provider
}

describe('assignFaces', () => {
  it('reports the reason a face was refused, not only its id', async () => {
    const lines: Line[] = []
    const boom = new Error('sample enrolment rejected the embedding')
    const provider = providerThatRefuses(lines, boom)

    const out = await provider.assignFaces({ faceIds: ['face-a'], identityId: 'id-1' })

    expect(out).toEqual({ assigned: 0, failed: ['face-a'] })
    const said = lines.find((l) => /refus|failed/i.test(l.message))
    expect(said, 'the reason was collected and thrown away').toBeDefined()
    expect(String(said?.meta?.error)).toContain('sample enrolment rejected the embedding')
    expect(said?.meta?.faceId).toBe('face-a')
  })

  it('names the identity too — a refusal is about a PAIR', async () => {
    const lines: Line[] = []
    const provider = providerThatRefuses(lines, new Error('nope'))

    await provider.assignFaces({ faceIds: ['face-a'], identityId: 'id-42' })

    expect(lines.find((l) => l.meta?.identityId === 'id-42')).toBeDefined()
  })

  it('still collects rather than aborting: face two is attempted after face one fails', async () => {
    const lines: Line[] = []
    const provider = providerThatRefuses(lines, new Error('nope'))

    const out = await provider.assignFaces({ faceIds: ['a', 'b', 'c'], identityId: 'id-1' })

    expect(out.failed).toEqual(['a', 'b', 'c'])
    expect(lines.filter((l) => l.meta?.faceId !== undefined)).toHaveLength(3)
  })
})
