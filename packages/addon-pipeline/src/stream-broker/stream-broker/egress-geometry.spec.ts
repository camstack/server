import { describe, expect, it } from 'vitest'
import { deliveredGeometry } from './egress-geometry.js'

describe('deliveredGeometry', () => {
  it('NEVER upscales — a 360p source asked for 720p delivers 360p', () => {
    // Measured on device 106: the Echo was served the 640×360 sub stream and
    // the published record claimed 1280×720.
    expect(
      deliveredGeometry({
        requestedWidth: 1280,
        requestedHeight: 720,
        sourceWidth: 640,
        sourceHeight: 360,
      }),
    ).toEqual({ width: 640, height: 360 })
  })

  it('DOES downscale — going down is the one direction allowed', () => {
    expect(
      deliveredGeometry({
        requestedWidth: 1280,
        requestedHeight: 720,
        sourceWidth: 2304,
        sourceHeight: 1296,
      }),
    ).toEqual({ width: 1280, height: 720 })
  })

  it('leaves an equal geometry alone', () => {
    expect(
      deliveredGeometry({
        requestedWidth: 1280,
        requestedHeight: 720,
        sourceWidth: 1280,
        sourceHeight: 720,
      }),
    ).toEqual({ width: 1280, height: 720 })
  })

  it('an UNKNOWN source never caps — a guess must not shrink a healthy stream', () => {
    // The manager defaults an unreadable source to 1280×720 for the argv
    // builder. That is a guess for a filter, not a fact about the camera, and
    // capping a 1080p request against it would silently halve it. (D393)
    expect(deliveredGeometry({ requestedWidth: 1920, requestedHeight: 1080 })).toEqual({
      width: 1920,
      height: 1080,
    })
    expect(
      deliveredGeometry({
        requestedWidth: 1920,
        requestedHeight: 1080,
        sourceWidth: 0,
        sourceHeight: 0,
      }),
    ).toEqual({ width: 1920, height: 1080 })
  })

  it('an unstated ask stays unstated — the source decides', () => {
    expect(deliveredGeometry({ sourceWidth: 640, sourceHeight: 360 })).toEqual({})
  })

  it('caps each axis on its own, the way the scale filter does', () => {
    // `scale='min(W,iw)':'min(H,ih)'` is per-axis; the aspect is then settled by
    // `force_original_aspect_ratio=decrease`. The record must describe the same
    // arithmetic the filter performs, not a different one.
    expect(
      deliveredGeometry({
        requestedWidth: 1280,
        requestedHeight: 720,
        sourceWidth: 640,
        sourceHeight: 1080,
      }),
    ).toEqual({ width: 640, height: 720 })
  })
})
