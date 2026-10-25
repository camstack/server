/**
 * The probe must not RUN — not "must produce the same answer".
 *
 * `avformat_find_stream_info` costs seconds on an RTP input because it waits on
 * live packets to estimate a frame rate the SDP never declares, and it is paid
 * again on every re-dial. A decoder that starts anyway is exactly what would
 * hide the defect: asserting that frames still come out passes identically
 * whether the seconds were spent or not. So every assertion here is about
 * WHETHER THE PROBE WAS EXECUTED, counted at the only place that can execute
 * it — the `skipStreamInfo` flag handed to `Demuxer.open`.
 *
 * The fake `open` mirrors node-av's real contract exactly: `Demuxer.open` calls
 * `avformat_find_stream_info` if and only if `skipStreamInfo` is falsy
 * (`node-av/dist/api/demuxer.js`: `if (!options.skipStreamInfo) …
 * findStreamInfo(null)`), so counting opens-without-the-flag counts probes.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  openPullDemuxer,
  type PullCodecParametersLike,
  type PullDemuxerLike,
  type PullDemuxerOpenOptions,
} from '../pull-demuxer-open.js'

const URL = 'rtsp://127.0.0.1:8554/dev-102/muted?intent=detection'
const OPTIONS: Record<string, string> = { rtsp_transport: 'tcp', probesize: '1000000' }

interface FakeDemuxer extends PullDemuxerLike {
  readonly label: string
  readonly disposed: () => boolean
}

interface OpenRecorder {
  /** Every `Demuxer.open` call, in order, with the flag that decides the probe. */
  readonly calls: PullDemuxerOpenOptions[]
  /** Opens that would have run `avformat_find_stream_info`. */
  readonly probeCount: () => number
  readonly open: (url: string, options: PullDemuxerOpenOptions) => Promise<FakeDemuxer>
}

function makeCodecpar(extradataSize: number): PullCodecParametersLike {
  return { extradataSize, parseExtradata: vi.fn(() => 0) }
}

function makeDemuxer(label: string, extradataSize: number | null): FakeDemuxer {
  let disposed = false
  const stream = extradataSize === null ? undefined : { codecpar: makeCodecpar(extradataSize) }
  return {
    label,
    disposed: () => disposed,
    video: () => stream,
    [Symbol.dispose]: () => {
      disposed = true
    },
  }
}

/**
 * `extradataByAttempt[n]` is what the nth open resolves with: a number is a
 * video stream carrying that many bytes of SDP-derived extradata, `null` is an
 * input with no video stream at all.
 */
function makeRecorder(extradataByAttempt: readonly (number | null)[]): OpenRecorder {
  const calls: PullDemuxerOpenOptions[] = []
  const demuxers: FakeDemuxer[] = []
  return {
    calls,
    probeCount: () => calls.filter((c) => !c.skipStreamInfo).length,
    open: (_url: string, options: PullDemuxerOpenOptions): Promise<FakeDemuxer> => {
      const attempt = calls.length
      calls.push(options)
      const demuxer = makeDemuxer(`attempt-${attempt}`, extradataByAttempt[attempt] ?? 0)
      demuxers.push(demuxer)
      return Promise.resolve(demuxer)
    },
  }
}

describe('openPullDemuxer — the stream-info probe', () => {
  it('does NOT run the probe when the opened input already carries the parameter sets', async () => {
    const recorder = makeRecorder([48])
    const note = vi.fn()

    const result = await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: new AbortController().signal,
      open: recorder.open,
      forceStreamInfoProbe: false,
      note,
    })

    // THE assertion: avformat_find_stream_info never ran.
    expect(recorder.probeCount()).toBe(0)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.skipStreamInfo).toBe(true)
    expect(result.streamInfoProbed).toBe(false)
    // The demuxer opened without the probe is the one handed back — no silent
    // second open behind it.
    expect(result.demuxer.label).toBe('attempt-0')
    // A skipped branch that says nothing is a skipped branch nobody can audit;
    // a taken fast path has nothing to report.
    expect(note).not.toHaveBeenCalled()
  })

  it('derives geometry from the SDP extradata instead of reading packets for it', async () => {
    const recorder = makeRecorder([48])

    const result = await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: new AbortController().signal,
      open: recorder.open,
      forceStreamInfoProbe: false,
      note: vi.fn(),
    })

    const codecpar = result.demuxer.video()?.codecpar
    expect(codecpar?.parseExtradata).toHaveBeenCalledTimes(1)
  })

  it('pays the probe when the open described no codec — and says so', async () => {
    // Attempt 0 opens with zero extradata (nothing was described); attempt 1 is
    // the probing re-open.
    const recorder = makeRecorder([0, 48])
    const note = vi.fn()

    const result = await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: new AbortController().signal,
      open: recorder.open,
      forceStreamInfoProbe: false,
      note,
    })

    expect(recorder.calls.map((c) => c.skipStreamInfo)).toEqual([true, false])
    expect(recorder.probeCount()).toBe(1)
    expect(result.streamInfoProbed).toBe(true)
    expect(result.demuxer.label).toBe('attempt-1')
    expect(note).toHaveBeenCalledTimes(1)
  })

  it('pays the probe when the open exposed no video stream at all', async () => {
    const recorder = makeRecorder([null, 48])

    const result = await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: new AbortController().signal,
      open: recorder.open,
      forceStreamInfoProbe: false,
      note: vi.fn(),
    })

    expect(recorder.probeCount()).toBe(1)
    expect(result.streamInfoProbed).toBe(true)
  })

  it('disposes the abandoned demuxer before re-opening — a fallback must not leak a dial', async () => {
    const recorder = makeRecorder([0, 48])
    const opened: FakeDemuxer[] = []
    const result = await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: new AbortController().signal,
      open: async (url, options) => {
        const demuxer = await recorder.open(url, options)
        opened.push(demuxer)
        return demuxer
      },
      forceStreamInfoProbe: false,
      note: vi.fn(),
    })

    expect(opened).toHaveLength(2)
    expect(opened[0]?.disposed()).toBe(true)
    expect(result.demuxer.disposed()).toBe(false)
  })

  it('CAMSTACK_DECODE_PROBE_STREAM_INFO restores the probe in ONE open — the A/B, not a second dial', async () => {
    const recorder = makeRecorder([48])

    const result = await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: new AbortController().signal,
      open: recorder.open,
      forceStreamInfoProbe: true,
      note: vi.fn(),
    })

    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0]?.skipStreamInfo).toBe(false)
    expect(recorder.probeCount()).toBe(1)
    expect(result.streamInfoProbed).toBe(true)
  })

  it('passes the demuxer options and the abort signal through unchanged on every attempt', async () => {
    const recorder = makeRecorder([0, 48])
    const controller = new AbortController()

    await openPullDemuxer({
      url: URL,
      demuxerOptions: OPTIONS,
      signal: controller.signal,
      open: recorder.open,
      forceStreamInfoProbe: false,
      note: vi.fn(),
    })

    for (const call of recorder.calls) {
      expect(call.options).toBe(OPTIONS)
      expect(call.signal).toBe(controller.signal)
    }
  })
})
