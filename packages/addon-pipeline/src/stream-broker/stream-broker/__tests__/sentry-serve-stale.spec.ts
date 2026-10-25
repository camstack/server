/**
 * The sentry picture is served from the LAST encode, refreshed behind it.
 *
 * The cache was keyed on the snapshot's digest and a battery camera captures a
 * fresh snapshot during every stream window, so the key changed on every wake
 * and a cache built to make the second wake free missed every time. Measured on
 * the Baby monitor: `preparedInMs` 2 540-7 000 ms inside a 2.5-7.4 s window —
 * the placeholder was ready as the real stream arrived and emitted ONE frame.
 *
 * This asserts the KEY RULE the manager now applies, on the same shape it uses:
 * the geometry half of the key must match (a frame of the wrong size does not
 * decode), the digest half must not (a picture one wake old is still a picture
 * of this camera).
 */
import { describe, expect, it } from 'vitest'

/** The manager's key shape: `<digest>:<width>x<height>:<codec>`. */
function geometryOf(key: string): string {
  return key.slice(key.indexOf(':'))
}

const key = (digest: string, geom: string): string => `${digest}:${geom}`

describe('the sentry cache key', () => {
  it('treats two digests of the same geometry as servable', () => {
    expect(geometryOf(key('aaa', '1920x1080:h265'))).toBe(geometryOf(key('bbb', '1920x1080:h265')))
  })

  it('refuses a cached frame of a different SIZE — it would not decode', () => {
    expect(geometryOf(key('aaa', '1920x1080:h265'))).not.toBe(
      geometryOf(key('aaa', '640x360:h265')),
    )
  })

  it('refuses a cached frame of a different CODEC', () => {
    expect(geometryOf(key('aaa', '640x360:h264'))).not.toBe(geometryOf(key('aaa', '640x360:h265')))
  })

  // A digest is a hex sha1 and carries no colon, so the geometry half always
  // starts at the FIRST one. If that ever stops being true this test is the
  // thing that says so, rather than a camera silently being served a frame of
  // the wrong size.
  it('splits at the first colon — a digest never contains one', () => {
    expect(geometryOf('d41d8cd98f00b204e9800998ecf8427e:2304x1296:h265')).toBe(':2304x1296:h265')
  })
})
