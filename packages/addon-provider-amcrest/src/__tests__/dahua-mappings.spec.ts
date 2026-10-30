import { describe, expect, it } from 'vitest'
import {
  amcrestBacklightToCap,
  amcrestDayNightModeToCap,
  amcrestExposureModeToCap,
  amcrestRotateToCap,
  capBacklightToAmcrest,
  capDayNightModeToAmcrest,
  capExposureModeToAmcrest,
  capRotateToAmcrest,
  clampDayNightDelaySec,
  DAY_NIGHT_DELAY_MAX_SEC,
  DAY_NIGHT_DELAY_MIN_SEC,
  DAY_NIGHT_SENSITIVITY_NATIVE_MAX,
  dayNightSensitivityToPercent,
  percentToDayNightSensitivity,
} from '../dahua-mappings.js'

/**
 * Every constant and token in this file was VERIFIED against the live
 * IP4M-1041B (192.168.10.80, firmware 2.800.1ENN001.0.R build 2024-10-29)
 * on 2026-09-04 by writing the value over CGI and reading it back:
 *
 *   - `VideoInDayNight[0][0].Mode` accepts exactly Color / Brightness /
 *     BlackWhite (`Photoresistor` → HTTP 400, state unchanged).
 *     `BlackWhite` was additionally confirmed functionally (snapshot went
 *     grayscale), `Brightness` restored color.
 *   - `Sensitivity` accepts 0..7 (8, 9, 10, 100 → Error).
 *   - `Delay` accepts 2..10 seconds (0, 1, 11..14, 15, 30, 60, 100,
 *     119, 120, 130 → Error).
 *   - `VideoImageControl[0].Rotate90=1` rotates for real (snapshot came
 *     back 1440×2560). `3` is stored but has no defined meaning — never
 *     emitted, mapped back to undefined.
 *   - `VideoInBacklight[0][0].Mode`: `Backlight` flips the legacy
 *     `VideoInOptions[0].Backlight` mirror to 1; `WideDynamic` visibly
 *     lifted shadows in a snapshot; `GlareInhibition` mirrors its
 *     intensity into `VideoInOptions[0].GlareInhibition`. The field is
 *     NOT validated (a bogus token is stored verbatim) so reads must
 *     tolerate unknown tokens.
 *   - `VideoInExposure[0][0].Mode` is validated (99 → Error); `4` +
 *     `Value1/2=1` produced a near-black frame (manual exposure real),
 *     `0` restored auto.
 */

describe('day/night mode mapping (verified enum: Color/Brightness/BlackWhite)', () => {
  it('maps the three live-verified native tokens onto the cap enum', () => {
    expect(amcrestDayNightModeToCap('Brightness')).toBe('auto')
    expect(amcrestDayNightModeToCap('Color')).toBe('day')
    expect(amcrestDayNightModeToCap('BlackWhite')).toBe('night')
  })

  it('falls back to auto for unknown/absent tokens (never throws on firmware drift)', () => {
    expect(amcrestDayNightModeToCap('Photoresistor')).toBe('auto')
    expect(amcrestDayNightModeToCap(undefined)).toBe('auto')
  })

  it('emits only tokens the firmware round-trips', () => {
    expect(capDayNightModeToAmcrest('auto')).toBe('Brightness')
    expect(capDayNightModeToAmcrest('day')).toBe('Color')
    expect(capDayNightModeToAmcrest('night')).toBe('BlackWhite')
  })

  it('refuses schedule — no verified Dahua token exists for it on this firmware', () => {
    expect(capDayNightModeToAmcrest('schedule')).toBeUndefined()
  })
})

describe('day/night sensitivity (native range 0..7, NOT 0..3)', () => {
  it('pins the native max to the live-verified 7', () => {
    // 8 was rejected by the camera; 7 was accepted. A max of 3 (the old
    // constant) would compress the top half of the slider into nothing.
    expect(DAY_NIGHT_SENSITIVITY_NATIVE_MAX).toBe(7)
  })

  it('round-trips every native step through the normalized percent space', () => {
    for (let native = 0; native <= DAY_NIGHT_SENSITIVITY_NATIVE_MAX; native++) {
      const pct = dayNightSensitivityToPercent(native)
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
      expect(percentToDayNightSensitivity(pct)).toBe(native)
    }
  })

  it('maps the endpoints exactly', () => {
    expect(dayNightSensitivityToPercent(0)).toBe(0)
    expect(dayNightSensitivityToPercent(7)).toBe(100)
    expect(percentToDayNightSensitivity(0)).toBe(0)
    expect(percentToDayNightSensitivity(100)).toBe(7)
  })

  it('clamps out-of-range percents to writable natives', () => {
    expect(percentToDayNightSensitivity(-5)).toBe(0)
    expect(percentToDayNightSensitivity(150)).toBe(7)
  })
})

describe('day/night switch delay (firmware accepts 2..10 s only)', () => {
  it('pins the live-verified bounds', () => {
    expect(DAY_NIGHT_DELAY_MIN_SEC).toBe(2)
    expect(DAY_NIGHT_DELAY_MAX_SEC).toBe(10)
  })

  it('clamps to the writable window — an unclamped 600 s would HTTP-400', () => {
    expect(clampDayNightDelaySec(0)).toBe(2)
    expect(clampDayNightDelaySec(1)).toBe(2)
    expect(clampDayNightDelaySec(6)).toBe(6)
    expect(clampDayNightDelaySec(11)).toBe(10)
    expect(clampDayNightDelaySec(600)).toBe(10)
    expect(clampDayNightDelaySec(7.6)).toBe(8)
  })
})

describe('rotate mapping (Rotate90: 0=off, 1=90° cw — snapshot-verified, 2=90° ccw)', () => {
  it('maps native ints onto the cap degrees-clockwise enum', () => {
    expect(amcrestRotateToCap(0)).toBe('0')
    expect(amcrestRotateToCap(1)).toBe('90')
    expect(amcrestRotateToCap(2)).toBe('270')
  })

  it('reports undefined for stored-but-meaningless values (3 was stored verbatim)', () => {
    expect(amcrestRotateToCap(3)).toBeUndefined()
    expect(amcrestRotateToCap(undefined)).toBeUndefined()
  })

  it('emits only the three real natives; 180 has no Dahua equivalent here', () => {
    expect(capRotateToAmcrest('0')).toBe(0)
    expect(capRotateToAmcrest('90')).toBe(1)
    expect(capRotateToAmcrest('270')).toBe(2)
    expect(capRotateToAmcrest('180')).toBeUndefined()
  })
})

describe('backlight mapping (Off/Backlight/WideDynamic/GlareInhibition)', () => {
  it('maps the four verified tokens 1:1 onto the cap enum', () => {
    expect(amcrestBacklightToCap('Off')).toBe('off')
    expect(amcrestBacklightToCap('Backlight')).toBe('blc')
    expect(amcrestBacklightToCap('WideDynamic')).toBe('wdr')
    expect(amcrestBacklightToCap('GlareInhibition')).toBe('hlc')
  })

  it('reads unknown stored tokens as undefined — the field is unvalidated on-camera', () => {
    expect(amcrestBacklightToCap('SSA')).toBeUndefined()
    expect(amcrestBacklightToCap(undefined)).toBeUndefined()
  })

  it('writes the exact Dahua tokens', () => {
    expect(capBacklightToAmcrest('off')).toBe('Off')
    expect(capBacklightToAmcrest('blc')).toBe('Backlight')
    expect(capBacklightToAmcrest('wdr')).toBe('WideDynamic')
    expect(capBacklightToAmcrest('hlc')).toBe('GlareInhibition')
  })
})

describe('exposure mode mapping (0=auto, 4=manual — manual verified functionally)', () => {
  it('maps the two cap modes onto the verified natives', () => {
    expect(amcrestExposureModeToCap(0)).toBe('auto')
    expect(amcrestExposureModeToCap(4)).toBe('manual')
    expect(capExposureModeToAmcrest('auto')).toBe(0)
    expect(capExposureModeToAmcrest('manual')).toBe(4)
  })

  it('reports undefined for the in-between natives (1..3 are vendor presets the cap cannot express)', () => {
    expect(amcrestExposureModeToCap(1)).toBeUndefined()
    expect(amcrestExposureModeToCap(2)).toBeUndefined()
    expect(amcrestExposureModeToCap(undefined)).toBeUndefined()
  })
})
