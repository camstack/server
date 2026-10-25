import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import { describeFfmpegProvisioning, getDefaultDataPath } from '../commands/setup.js'

describe('describeFfmpegProvisioning', () => {
  it('names the pinned download, and never asks for a host install (D540)', () => {
    const line = describeFfmpegProvisioning({})
    expect(line).toContain('pinned build')
    expect(line).not.toContain('install ffmpeg')
  })

  it("names the operator's override when one is set", () => {
    expect(
      describeFfmpegProvisioning({ CAMSTACK_FFMPEG_PATH: '/opt/ffmpeg/bin/ffmpeg' }),
    ).toContain('CAMSTACK_FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg')
  })
})

describe('getDefaultDataPath', () => {
  it('returns the cwd-relative data directory', () => {
    expect(getDefaultDataPath()).toBe(path.join(process.cwd(), 'camstack-data'))
  })
})
