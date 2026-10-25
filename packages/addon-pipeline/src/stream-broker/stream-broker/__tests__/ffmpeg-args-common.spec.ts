import { describe, it, expect } from 'vitest'
import { audioEncoderArgs, logBannerArgs } from '../ffmpeg-args-common.js'

describe('audioEncoderArgs', () => {
  it('maps each codec to its ffmpeg encoder', () => {
    expect(audioEncoderArgs('opus')).toEqual(['-c:a', 'libopus'])
    expect(audioEncoderArgs('aac')).toEqual(['-c:a', 'aac'])
    expect(audioEncoderArgs('pcmu')).toEqual(['-c:a', 'pcm_mulaw'])
    expect(audioEncoderArgs('pcma')).toEqual(['-c:a', 'pcm_alaw'])
    expect(audioEncoderArgs('copy')).toEqual(['-c:a', 'copy'])
  })

  it('emits knobs only when provided, in fixed order (-b:a, -ar, -ac)', () => {
    expect(audioEncoderArgs('aac', { bitrateKbps: 128, sampleRateHz: 48000, channels: 2 })).toEqual(
      ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
    )
    expect(audioEncoderArgs('pcmu', { sampleRateHz: 8000, channels: 1 })).toEqual([
      '-c:a',
      'pcm_mulaw',
      '-ar',
      '8000',
      '-ac',
      '1',
    ])
    expect(audioEncoderArgs('opus', { bitrateKbps: 64 })).toEqual([
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
    ])
  })
})

describe('logBannerArgs', () => {
  it('emits the hide-banner + loglevel preamble', () => {
    expect(logBannerArgs('error')).toEqual(['-hide_banner', '-loglevel', 'error'])
    expect(logBannerArgs('warning')).toEqual(['-hide_banner', '-loglevel', 'warning'])
  })
})
