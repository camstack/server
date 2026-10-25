import { describe, it, expect } from 'vitest'
import { composeVfFilter, upsertVfInOutputArgs } from '../GeometryBuilder.js'

describe('composeVfFilter', () => {
  it('composes scale + pad + setdar for a target aspect (pad mode)', () => {
    expect(composeVfFilter({ targetAspect: '16:9', mode: 'pad', width: 1920, height: 1080 })).toBe(
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setdar=16/9',
    )
  })
  it('composes scale + crop + setdar for a target aspect (crop mode)', () => {
    expect(composeVfFilter({ targetAspect: '16:9', mode: 'crop', width: 1920, height: 1080 })).toBe(
      'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setdar=16/9',
    )
  })
  it('composes a crop/zoom rectangle', () => {
    expect(composeVfFilter({ crop: { x: 100, y: 50, w: 1280, h: 720 } })).toBe(
      'crop=1280:720:100:50',
    )
  })
  it('composes rotate 90 / 180 / 270', () => {
    expect(composeVfFilter({ rotate: 90 })).toBe('transpose=1')
    expect(composeVfFilter({ rotate: 270 })).toBe('transpose=2')
    expect(composeVfFilter({ rotate: 180 })).toBe('hflip,vflip')
  })
  it('composes hflip/vflip', () => {
    expect(composeVfFilter({ hflip: true, vflip: true })).toBe('hflip,vflip')
  })
  it('returns empty string for no-op opts', () => {
    expect(composeVfFilter({})).toBe('')
  })
})

describe('upsertVfInOutputArgs', () => {
  it('replaces a prior -vf pair without clobbering other args', () => {
    expect(
      upsertVfInOutputArgs(
        ['-x264-params', 'scenecut=0', '-vf', 'crop=10:10:0:0'],
        'scale=1920:1080',
      ),
    ).toEqual(['-x264-params', 'scenecut=0', '-vf', 'scale=1920:1080'])
  })
  it('appends -vf when none present', () => {
    expect(upsertVfInOutputArgs(['-flush_packets', '1'], 'transpose=1')).toEqual([
      '-flush_packets',
      '1',
      '-vf',
      'transpose=1',
    ])
  })
  it('removes the -vf pair entirely when chain is empty', () => {
    expect(upsertVfInOutputArgs(['-vf', 'crop=10:10:0:0', '-flush_packets', '1'], '')).toEqual([
      '-flush_packets',
      '1',
    ])
  })
})
