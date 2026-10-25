/**
 * The Test tab's half of the `/addon/ai/test-chat` NDJSON stream.
 *
 * The addon owns the schema and the client never sees it, so this file is the
 * ONLY thing standing between an older/newer hub and a bubble rendering
 * `undefined`. The chunk-boundary test is the one that matters most: a network
 * read splits wherever TCP likes, and a reader that assumes one line per read
 * works on localhost and corrupts the first answer over a slow link.
 */
import { describe, expect, it } from 'vitest'
import {
  type ChatTurn,
  type TestChatEvent,
  TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS,
  describeAttachment,
  firstTokenBudgetFor,
  parseEvent,
  phaseLabel,
  readEvents,
  thumbnailDataUrl,
  transcriptForRequest,
  turnsFromStoredChat,
} from '../ai-test-chat.helpers'

/** A ReadableStream that emits exactly the byte chunks given. */
function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<TestChatEvent[]> {
  const out: TestChatEvent[] = []
  for await (const event of readEvents(stream)) out.push(event)
  return out
}

describe('parseEvent', () => {
  it('reads a token', () => {
    expect(parseEvent('{"kind":"token","text":"a van"}')).toEqual({ kind: 'token', text: 'a van' })
  })

  it('reads the meta line, including what media the SERVER says it sent', () => {
    expect(
      parseEvent(
        JSON.stringify({
          kind: 'meta',
          profileName: 'Mac LM Studio',
          model: 'qwen/qwen3-vl-8b',
          mediaSent: {
            kind: 'snapshot',
            mimeType: 'image/jpeg',
            sizeBytes: 120_000,
            thumbnailBase64: 'QUJD',
          },
          streamed: true,
          firstTokenTimeoutMs: 120_000,
        }),
      ),
    ).toMatchObject({
      kind: 'meta',
      profileName: 'Mac LM Studio',
      streamed: true,
      mediaSent: { kind: 'snapshot', sizeBytes: 120_000, thumbnailBase64: 'QUJD' },
    })
  })

  it('reads an error as a failure, never as prose', () => {
    expect(
      parseEvent('{"kind":"error","code":"timeout","message":"no output within 120s"}'),
    ).toEqual({ kind: 'error', code: 'timeout', message: 'no output within 120s' })
  })

  /** A line this build cannot read is SKIPPED — never half-rendered. */
  it('returns null for junk, an unknown kind, or a malformed payload', () => {
    expect(parseEvent('not json')).toBeNull()
    expect(parseEvent('{"kind":"hologram"}')).toBeNull()
    expect(parseEvent('{"kind":"token"}')).toBeNull()
    expect(parseEvent('{"kind":"status","phase":"vibing"}')).toBeNull()
  })

  it('drops an attachment whose shape it does not recognise rather than half-reading it', () => {
    const event = parseEvent(
      JSON.stringify({
        kind: 'meta',
        profileName: 'p',
        model: 'm',
        mediaSent: { kind: 'hologram', mimeType: 'image/jpeg', sizeBytes: 1 },
        streamed: true,
        firstTokenTimeoutMs: 1,
      }),
    )
    expect(event?.kind === 'meta' && event.mediaSent).toBeNull()
  })
})

describe('readEvents', () => {
  it('yields one event per line', async () => {
    const events = await collect(
      streamOf('{"kind":"token","text":"a"}\n{"kind":"token","text":"b"}\n'),
    )
    expect(events).toEqual([
      { kind: 'token', text: 'a' },
      { kind: 'token', text: 'b' },
    ])
  })

  /** THE reader test: a line split across two network reads. */
  it('buffers across a chunk boundary that falls inside a line', async () => {
    const line = '{"kind":"token","text":"hello world"}\n'
    const cut = 12
    const events = await collect(streamOf(line.slice(0, cut), line.slice(cut)))
    expect(events).toEqual([{ kind: 'token', text: 'hello world' }])
  })

  it('yields a final line the server did not terminate', async () => {
    expect(await collect(streamOf('{"kind":"token","text":"tail"}'))).toEqual([
      { kind: 'token', text: 'tail' },
    ])
  })

  it('skips an unreadable line and keeps the answer around it', async () => {
    const events = await collect(
      streamOf('{"kind":"token","text":"kept"}\n{oops\n{"kind":"done"}\n'),
    )
    expect(events.map((e) => e.kind)).toEqual(['token', 'done'])
  })
})

describe('transcriptForRequest', () => {
  function turn(over: Partial<ChatTurn>): ChatTurn {
    return { id: 'i', role: 'user', content: 'c', ...over }
  }

  /**
   * A "profile is not vision-capable" bubble is THIS PAGE talking, not the
   * model. Feeding it back as an assistant turn teaches the model to apologise
   * for something it never said — and the operator's next question then lands
   * on a poisoned transcript.
   */
  it('drops failed assistant turns from the next request', () => {
    expect(
      transcriptForRequest([
        turn({ id: '1', role: 'user', content: 'what is it?' }),
        turn({ id: '2', role: 'assistant', content: 'bad-request: not vision', failed: true }),
        turn({ id: '3', role: 'user', content: 'and now?' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'what is it?' },
      { role: 'user', content: 'and now?' },
    ])
  })

  it('keeps successful assistant turns so the exchange stays multi-turn', () => {
    expect(
      transcriptForRequest([
        turn({ id: '1', role: 'user', content: 'hi' }),
        turn({ id: '2', role: 'assistant', content: 'hello' }),
      ]),
    ).toHaveLength(2)
  })
})

describe('phaseLabel', () => {
  /**
   * The phase that made the original failure look like a hang. A cold GPU load
   * and a wedged transport produce the same silence; this line is the whole
   * difference, so it has to name the bound.
   */
  it('says a cold load is expected, and how long it may take', () => {
    const label = phaseLabel('first-token-wait', 120_000)
    expect(label).toMatch(/cold load/i)
    expect(label).toMatch(/120s/)
  })

  /**
   * This phase is now announced the moment the SOCKET is up — before `meta`,
   * and on a cold box minutes before it. If the page had no bound to quote it
   * would render "up to 0s" for the entire wait, which is the one number
   * guaranteed to be wrong.
   */
  it('still reads as a cold load when no bound is known yet, without quoting 0s', () => {
    const label = phaseLabel('first-token-wait', 0)
    expect(label).toMatch(/cold load/i)
    expect(label).not.toMatch(/0s/)
  })

  it('distinguishes fetching the picture from talking to the provider', () => {
    expect(phaseLabel('resolving-image', 0)).toMatch(/picture/i)
    expect(phaseLabel('connecting', 0)).toMatch(/provider/i)
    expect(phaseLabel('streaming', 0)).toMatch(/answering/i)
  })
})

describe('describeAttachment', () => {
  it('says what was sent, how big and which stored variant', () => {
    const text = describeAttachment({
      kind: 'track',
      mimeType: 'image/jpeg',
      sizeBytes: 48 * 1024,
      mediaKind: 'keyFrameSmall',
    })
    expect(text).toContain('track best-shot')
    expect(text).toContain('48 KB')
    expect(text).toContain('keyFrameSmall')
  })

  it('names a camera frame as a camera frame', () => {
    expect(
      describeAttachment({ kind: 'snapshot', mimeType: 'image/jpeg', sizeBytes: 2 * 1024 * 1024 }),
    ).toContain('camera snapshot')
  })
})

/**
 * The remedy the cold-load error names — "raise the first-token timeout" — is
 * only true if the page actually sends the profile's bound. It did not: the
 * field on the Profiles tab changed nothing here, and the addon quietly used
 * its own 120 s default.
 */
describe('firstTokenBudgetFor', () => {
  it("sends the profile's own first-token bound", () => {
    expect(firstTokenBudgetFor({ firstTokenTimeoutMs: 300_000 })).toBe(300_000)
  })

  it('clamps rather than letting a .strict() schema 400 the whole run', () => {
    expect(firstTokenBudgetFor({ firstTokenTimeoutMs: 900_000 })).toBe(
      TEST_CHAT_MAX_FIRST_TOKEN_TIMEOUT_MS,
    )
  })

  it('omits the field entirely when the profile has nothing usable to say', () => {
    expect(firstTokenBudgetFor({})).toBeUndefined()
    expect(firstTokenBudgetFor({ firstTokenTimeoutMs: 0 })).toBeUndefined()
    expect(firstTokenBudgetFor({ firstTokenTimeoutMs: Number.NaN })).toBeUndefined()
  })
})

describe('thumbnailDataUrl', () => {
  it('turns mediaSent.thumbnailBase64 into a data URL the transcript can render', () => {
    expect(
      thumbnailDataUrl({
        kind: 'snapshot',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        thumbnailBase64: 'QUJD',
      }),
    ).toBe('data:image/jpeg;base64,QUJD')
    expect(thumbnailDataUrl({ kind: 'snapshot', mimeType: 'image/jpeg', sizeBytes: 1 })).toBeNull()
  })
})

describe('turnsFromStoredChat', () => {
  it('replays stored messages including mediaSent so a reopened chat shows the picture', () => {
    const turns = turnsFromStoredChat({
      id: 'c1',
      messages: [
        {
          role: 'user',
          content: 'what is this?',
          mediaSent: {
            kind: 'snapshot',
            mimeType: 'image/jpeg',
            sizeBytes: 3,
            thumbnailBase64: 'QUJD',
          },
          attachment: { kind: 'snapshot', deviceId: 102 },
        },
        { role: 'assistant', content: 'a van' },
      ],
    })
    expect(turns[0]?.attachment?.thumbnailBase64).toBe('QUJD')
    expect(turns[0]?.attachmentKind).toBe('snapshot')
    expect(turns[1]?.content).toBe('a van')
  })
})
