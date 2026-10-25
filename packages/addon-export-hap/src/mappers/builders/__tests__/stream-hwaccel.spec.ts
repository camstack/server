/**
 * Hardware-accelerated DECODE on the HomeKit transcode path.
 *
 * The transcode branch was pure software — `libx264 -preset ultrafast` with no
 * decoder-side flag at all — and an independent measurement put a 4K→1080p
 * session at 77 % of one core, dominated by DECODE, on a hub already at 70-95 %
 * main-thread. H.265 cameras have no choice: iOS Home renders only H.264 over
 * the classic HAP SRTP path.
 *
 * The two things these tests hold down:
 *
 *  1. **Nothing is assumed about the host.** The backend comes from the
 *     decoder addon's own per-node probe, never from a hardcoded `qsv`. A flag
 *     naming a device the node does not have turns a working stream into no
 *     stream, which is precisely the year-long failure we just escaped.
 *  2. **A hardware failure degrades to software, not to a blank tile.**
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RENDER_DEVICE,
  HW_DECODE_FALLBACK_WINDOW_MS,
  isHwAccelBackend,
  selectHwDecode,
  shouldRetryInSoftware,
} from '../stream-hwaccel.js'

const PROBED_VAAPI = { hwaccel: 'auto', probedBestHwaccel: 'vaapi' }

describe('isHwAccelBackend', () => {
  it('accepts every backend the decoder cap can publish', () => {
    for (const value of ['videotoolbox', 'cuda', 'nvdec', 'vaapi', 'qsv', 'd3d11va', 'amf']) {
      expect(isHwAccelBackend(value), value).toBe(true)
    }
  })

  it('rejects the decoder settings that are not backends', () => {
    // `auto` and `none` are operator CHOICES, not devices; `''` is "never
    // probed". Treating any of them as a backend would emit `-hwaccel auto`
    // from the wrong branch or `-hwaccel none`, which ffmpeg rejects.
    for (const value of ['auto', 'none', '', 'qsv ', 'QSV', 'magic']) {
      expect(isHwAccelBackend(value), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('selectHwDecode — a backend that already died in this process', () => {
  /**
   * The gap Phase 0 closes. HomeKit's own `shouldRetryInSoftware` saved the
   * SESSION that hit a broken backend and told nobody, so the next session
   * re-picked it and paid the same two-second death — the exact failure the
   * broker fixed for its own children in 26a522cd5 by writing its 60 s memo to
   * software the moment a child reported the backend produced nothing.
   *
   * This is per-BACKEND, not a blanket "hardware failed": a host whose vaapi is
   * out of memory may still have a working qsv, and writing hardware off
   * wholesale would be a downgrade nobody asked for.
   */
  it('skips a backend the last session could not start', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: PROBED_VAAPI,
      platform: 'linux',
      recentlyFailedBackend: 'vaapi',
    })

    expect(decision).toMatchObject({ kind: 'software', reason: 'hardware-attempt-failed' })
  })

  it('still uses a DIFFERENT backend than the one that failed', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: PROBED_VAAPI,
      platform: 'linux',
      recentlyFailedBackend: 'qsv',
    })

    expect(decision).toMatchObject({ kind: 'hardware', backend: 'vaapi' })
  })

  it('overrides even the operator’s explicit pin — a dead device is dead', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'vaapi', probedBestHwaccel: 'vaapi' },
      platform: 'linux',
      recentlyFailedBackend: 'vaapi',
    })

    expect(decision).toMatchObject({ kind: 'software', reason: 'hardware-attempt-failed' })
  })

  it('does nothing when no backend has failed', () => {
    expect(
      selectHwDecode({
        transcode: true,
        reading: PROBED_VAAPI,
        platform: 'linux',
        recentlyFailedBackend: null,
      }),
    ).toMatchObject({ kind: 'hardware', backend: 'vaapi' })
  })
})

describe('selectHwDecode — what decides the backend', () => {
  it('takes the decoder addon PROBED backend when the operator left it on auto', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: PROBED_VAAPI,
      platform: 'linux',
    })

    expect(decision).toMatchObject({ kind: 'hardware', backend: 'vaapi', source: 'probed' })
  })

  it("lets the operator's explicit backend win over the probe", () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'cuda', probedBestHwaccel: 'vaapi' },
      platform: 'linux',
    })

    expect(decision).toMatchObject({ kind: 'hardware', backend: 'cuda', source: 'operator' })
  })

  it('honours the operator turning hardware decode OFF', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'none', probedBestHwaccel: 'vaapi' },
      platform: 'linux',
    })

    expect(decision).toEqual({
      kind: 'software',
      reason: 'operator-disabled',
      hwaccel: null,
      extraInputArgs: [],
      args: [],
    })
  })

  it('stays in software when the node has never been probed', () => {
    // The decoder seeds `probedBestHwaccel` at boot, so an empty value means
    // the probe has not run or found nothing. Guessing here is the failure
    // mode this whole module exists to avoid.
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'auto', probedBestHwaccel: '' },
      platform: 'linux',
    })

    expect(decision).toEqual({
      kind: 'software',
      reason: 'not-probed',
      hwaccel: null,
      extraInputArgs: [],
      args: [],
    })
  })

  it('stays in software when no decoder cap answered', () => {
    const decision = selectHwDecode({ transcode: true, reading: null, platform: 'linux' })

    expect(decision).toEqual({
      kind: 'software',
      reason: 'no-decoder-reading',
      hwaccel: null,
      extraInputArgs: [],
      args: [],
    })
  })

  it('stays in software on a backend name it does not recognise', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'auto', probedBestHwaccel: 'quantum' },
      platform: 'linux',
    })

    expect(decision).toEqual({
      kind: 'software',
      reason: 'unrecognised-backend',
      hwaccel: null,
      extraInputArgs: [],
      args: [],
    })
  })

  it('adds no decoder flag at all on the PASS-THROUGH path', () => {
    // `-c:v copy` never decodes. A `-hwaccel` there costs an init on every
    // session and can fail a stream that had nothing to gain.
    const decision = selectHwDecode({
      transcode: false,
      reading: PROBED_VAAPI,
      platform: 'linux',
    })

    expect(decision).toEqual({
      kind: 'software',
      reason: 'pass-through',
      hwaccel: null,
      extraInputArgs: [],
      args: [],
    })
  })

  it('stays in software once a hardware attempt in this session has failed', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: PROBED_VAAPI,
      platform: 'linux',
      hardwareAlreadyFailed: true,
    })

    expect(decision).toEqual({
      kind: 'software',
      reason: 'hardware-attempt-failed',
      hwaccel: null,
      extraInputArgs: [],
      args: [],
    })
  })
})

describe('selectHwDecode — the argument vector', () => {
  it('names a render device for the backends that need one', () => {
    for (const backend of ['vaapi', 'qsv']) {
      const decision = selectHwDecode({
        transcode: true,
        reading: { hwaccel: backend, probedBestHwaccel: '' },
        platform: 'linux',
      })
      expect(decision.args).toEqual(['-hwaccel', backend, '-hwaccel_device', DEFAULT_RENDER_DEVICE])
    }
  })

  it('accepts an operator-supplied render device', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: PROBED_VAAPI,
      platform: 'linux',
      renderDevice: '/dev/dri/renderD129',
    })

    expect(decision.args).toEqual(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129'])
  })

  it('does NOT name a render device for the backends that have none', () => {
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'cuda', probedBestHwaccel: '' },
      platform: 'linux',
    })

    expect(decision.args).toEqual(['-hwaccel', 'cuda'])
  })

  it('never sets -hwaccel_output_format', () => {
    // The frames have to come back to system memory for libx264. Keeping them
    // on the GPU without a GPU scale filter is how a decode succeeds and the
    // encode then gets nothing.
    const decision = selectHwDecode({ transcode: true, reading: PROBED_VAAPI, platform: 'linux' })
    expect(decision.args).not.toContain('-hwaccel_output_format')
  })

  it('dials VideoToolbox through `-hwaccel auto` on macOS', () => {
    // Carried over from the ffmpeg decoder addon, which learned it the hard
    // way: an EXPLICIT `-hwaccel videotoolbox` tears down under several
    // concurrent decode children, and `auto` picks VT anyway.
    const decision = selectHwDecode({
      transcode: true,
      reading: { hwaccel: 'auto', probedBestHwaccel: 'videotoolbox' },
      platform: 'darwin',
    })

    expect(decision).toMatchObject({ kind: 'hardware', backend: 'videotoolbox' })
    expect(decision.args).toEqual(['-hwaccel', 'auto'])
  })
})

describe('shouldRetryInSoftware', () => {
  const failing = {
    usedHardware: true,
    hardwareAlreadyFailed: false,
    stopRequestedByController: false,
    videoPacketsForwarded: 0,
    runtimeMs: 500,
  }

  it('retries when a hardware child dies early having produced nothing', () => {
    expect(shouldRetryInSoftware(failing)).toBe(true)
  })

  it('does not retry a SOFTWARE child — there is nothing to fall back to', () => {
    expect(shouldRetryInSoftware({ ...failing, usedHardware: false })).toBe(false)
  })

  it('never retries twice', () => {
    expect(shouldRetryInSoftware({ ...failing, hardwareAlreadyFailed: true })).toBe(false)
  })

  it('does not retry a teardown the CONTROLLER asked for', () => {
    // iOS restarting a session it is not enjoying looks identical to an
    // ffmpeg failure at the exit code; only this flag separates them.
    expect(shouldRetryInSoftware({ ...failing, stopRequestedByController: true })).toBe(false)
  })

  it('does not retry once media has flowed — hardware init clearly worked', () => {
    expect(shouldRetryInSoftware({ ...failing, videoPacketsForwarded: 1 })).toBe(false)
  })

  it('does not retry a child that ran past the init window', () => {
    expect(shouldRetryInSoftware({ ...failing, runtimeMs: HW_DECODE_FALLBACK_WINDOW_MS + 1 })).toBe(
      false,
    )
  })
})
