/**
 * What a thrown `videoclips.dialClipStream` means to the broker (D597): a
 * provider that predates the method is `unavailable`, a clip-vocabulary
 * refusal keeps its code, and anything else is `fetch-failed` verbatim.
 */
import { describe, expect, it } from 'vitest'
import { dialAnswerFromError } from '../clip-stream-dial-answer'

class TrpcLikeError extends Error {
  constructor(
    message: string,
    readonly data: { readonly code: string },
  ) {
    super(message)
  }
}

describe('dialAnswerFromError', () => {
  it('names a provider that predates the method as `unavailable`, by tRPC code or by prose', () => {
    expect(
      dialAnswerFromError(
        new TrpcLikeError('Capability "videoclips" provider does not implement "dialClipStream"', {
          code: 'NOT_IMPLEMENTED',
        }),
      ),
    ).toMatchObject({ kind: 'unavailable' })
    expect(
      dialAnswerFromError(
        new Error('child-cap-dispatch: provider does not implement dialClipStream'),
      ),
    ).toMatchObject({ kind: 'unavailable' })
  })

  it('keeps a clip-vocabulary refusal and its prose', () => {
    expect(dialAnswerFromError(new Error('sleeping: a standalone battery camera'))).toEqual({
      kind: 'refused',
      code: 'sleeping',
      detail: 'a standalone battery camera',
    })
    expect(
      dialAnswerFromError(new Error('unsupported-option: the stream serves the sub twin only')),
    ).toEqual({
      kind: 'refused',
      code: 'unsupported-option',
      detail: 'the stream serves the sub twin only',
    })
  })

  it('turns anything else into `fetch-failed` with the message verbatim', () => {
    expect(dialAnswerFromError(new Error('ECONNRESET'))).toEqual({
      kind: 'refused',
      code: 'fetch-failed',
      detail: 'ECONNRESET',
    })
    expect(dialAnswerFromError('boom')).toEqual({
      kind: 'refused',
      code: 'fetch-failed',
      detail: 'boom',
    })
  })
})
