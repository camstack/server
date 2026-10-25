import { describe, expect, it } from 'vitest'
import {
  classifyAudioWrite,
  patchStreamAudioEnabled,
  readStreamAudioEnabled,
} from '../hikvision-stream-audio.js'

/**
 * `<Audio><enabled>` — the camera's microphone mux.
 *
 * What these guard, in order of what would hurt most:
 *
 *  1. **Patching the wrong `<enabled>` takes the camera off the air.** The
 *     document's FIRST `<enabled>` is the streaming channel itself. Every
 *     fixture below carries both so a naive first-match implementation cannot
 *     pass.
 *  2. **No `<Audio>` block is `null`, never `false`.** A camera with no
 *     microphone must not be offered a mute switch, and must never be
 *     reported as one an operator silenced.
 */

/** A real-shaped channel document: channel `<enabled>` FIRST, audio second. */
function channelXml(opts: { audio?: 'true' | 'false'; channelEnabled?: string } = {}): string {
  const audioBlock =
    opts.audio === undefined
      ? ''
      : `<Audio><enabled>${opts.audio}</enabled><audioInputChannelID>1</audioInputChannelID><audioCompressionType>G.711ulaw</audioCompressionType></Audio>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<StreamingChannel version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    '<id>101</id>',
    '<channelName>Camera 01</channelName>',
    `<enabled>${opts.channelEnabled ?? 'true'}</enabled>`,
    '<Video><enabled>true</enabled><videoCodecType>H.265</videoCodecType><maxFrameRate>2500</maxFrameRate></Video>',
    audioBlock,
    '</StreamingChannel>',
  ].join('')
}

describe('readStreamAudioEnabled', () => {
  it('reads the nested Audio flag, not the channel-level enabled that precedes it', () => {
    // The discriminating case: the channel says true, the microphone says
    // false. A first-`<enabled>` implementation returns true here.
    expect(readStreamAudioEnabled(channelXml({ audio: 'false', channelEnabled: 'true' }))).toBe(
      false,
    )
  })

  it('reads an enabled microphone as true', () => {
    expect(readStreamAudioEnabled(channelXml({ audio: 'true' }))).toBe(true)
  })

  it('is null when the firmware emits no Audio block at all', () => {
    // "This camera has no microphone" — NOT "the microphone is off".
    expect(readStreamAudioEnabled(channelXml())).toBeNull()
  })

  it('is null when the Audio block carries no enabled flag', () => {
    expect(
      readStreamAudioEnabled(
        '<StreamingChannel><enabled>true</enabled><Audio><audioCompressionType>G.711ulaw</audioCompressionType></Audio></StreamingChannel>',
      ),
    ).toBeNull()
  })

  it('tolerates whitespace and casing the way firmware emits it', () => {
    expect(
      readStreamAudioEnabled(
        '<StreamingChannel><enabled>false</enabled><Audio>\n  <enabled> TRUE </enabled>\n</Audio></StreamingChannel>',
      ),
    ).toBe(true)
  })
})

describe('patchStreamAudioEnabled', () => {
  it('flips the microphone and leaves the channel-level enabled untouched', () => {
    const next = patchStreamAudioEnabled(
      channelXml({ audio: 'true', channelEnabled: 'true' }),
      false,
    )
    expect(readStreamAudioEnabled(next)).toBe(false)
    // The load-bearing assertion: the CHANNEL is still on. Getting this wrong
    // mutes the camera by taking its video stream down.
    expect(next).toContain(
      '<id>101</id><channelName>Camera 01</channelName><enabled>true</enabled>',
    )
  })

  it('turns the microphone back on without disturbing the rest of the document', () => {
    const before = channelXml({ audio: 'false' })
    const next = patchStreamAudioEnabled(before, true)
    expect(readStreamAudioEnabled(next)).toBe(true)
    expect(next).toContain('<videoCodecType>H.265</videoCodecType>')
    expect(next).toContain('<audioCompressionType>G.711ulaw</audioCompressionType>')
    expect(next.length).toBe(before.length - 1)
  })

  it('does not touch the Video block’s own enabled flag', () => {
    const next = patchStreamAudioEnabled(channelXml({ audio: 'true' }), false)
    expect(next).toContain('<Video><enabled>true</enabled>')
  })

  it('returns the document unchanged when there is nothing to patch', () => {
    const before = channelXml()
    expect(patchStreamAudioEnabled(before, false)).toBe(before)
  })
})

/**
 * The read-back verdict.
 *
 * A privacy control that half-applies is worse than one that is unavailable —
 * the operator believes the camera is silent and it is not (D74). These pin the
 * three ways a write can come back wrong.
 */
describe('classifyAudioWrite', () => {
  const ch = (channelId: string, audioEnabled: boolean) => ({ channelId, audioEnabled })

  it('accepts every channel that now holds the requested value', () => {
    const out = classifyAudioWrite(
      ['101', '102', '103'],
      [ch('101', false), ch('102', false), ch('103', false)],
      false,
    )
    expect(out).toEqual({ accepted: ['101', '102', '103'], refused: [] })
  })

  it('names the channel that took the call and did not move', () => {
    // The measured Reolink `thirdStream` shape, in Hikvision clothing: 200 OK
    // on every PUT, one register unchanged.
    const out = classifyAudioWrite(
      ['101', '102', '103'],
      [ch('101', false), ch('102', false), ch('103', true)],
      false,
    )
    expect(out).toEqual({ accepted: ['101', '102'], refused: ['103'] })
  })

  it('counts a channel that stopped answering as REFUSED, not as absent', () => {
    // Missing from the read-back is not evidence it took the change. Treating
    // it as accepted is how a camera stays audible while reporting silence.
    const out = classifyAudioWrite(['101', '102'], [ch('101', false)], false)
    expect(out).toEqual({ accepted: ['101'], refused: ['102'] })
  })

  it('works the same for the ENABLE direction', () => {
    // The mute direction is the one that got the revert; the un-mute is the
    // one that broke 104 in production. Both are verified.
    const out = classifyAudioWrite(
      ['101', '102', '103'],
      [ch('101', true), ch('102', true), ch('103', false)],
      true,
    )
    expect(out).toEqual({ accepted: ['101', '102'], refused: ['103'] })
  })
})
