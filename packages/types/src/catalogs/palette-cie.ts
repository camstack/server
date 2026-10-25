/**
 * CIEDE2000 and WCAG contrast for the display palette (D939).
 *
 * One implementation, shared by the hub validator, the admin editor and
 * (phase 2) the viewer. The arithmetic matches the viewer's `src/theme/cie.ts`.
 */

/** Page backgrounds the contrast rule is measured against. */
export const PALETTE_BACKGROUNDS = {
  dark: '#0c0a09',
  light: '#fafaf9',
} as const

export type PaletteBackground = keyof typeof PALETTE_BACKGROUNDS

/** Two entries closer than this read as one mark. */
export const PALETTE_MIN_DELTA_E = 7

/**
 * The live cursor and the heatmap handle sit next to each other as small
 * swatches. ΔE 7 still lets two olives read as one (the old CamStack pair
 * was 12.8 on the same hue). The global floor stays 7 — the presets' closest
 * pairs are 7.30, 7.49 and 7.01 — and these two marks must clear 20.
 */
export const PALETTE_MIN_DELTA_E_MARK = 20

/** Marks that are not event kinds and share the raised distance floor. */
export const PALETTE_MARK_PAIR = ['live', 'heatmapScrub'] as const

/** Minimum WCAG contrast of an entry against either theme background. */
export const PALETTE_MIN_CONTRAST = 3

const HEX = /^#[0-9a-fA-F]{6}$/

interface Lab {
  readonly L: number
  readonly a: number
  readonly b: number
}

function srgbChannel(hex: string, start: number): number {
  return Number.parseInt(hex.slice(start, start + 2), 16)
}

function srgbToLin(channel: number): number {
  const x = channel / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const r = srgbToLin(srgbChannel(hex, 1))
  const g = srgbToLin(srgbChannel(hex, 3))
  const b = srgbToLin(srgbChannel(hex, 5))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two `#rrggbb` colours. Non-hex returns 0. */
export function contrastRatio(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) return 0
  const hi = Math.max(relativeLuminance(a), relativeLuminance(b))
  const lo = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (hi + 0.05) / (lo + 0.05)
}

function xyzToLab(hex: string): Lab {
  const r = srgbToLin(srgbChannel(hex, 1))
  const g = srgbToLin(srgbChannel(hex, 3))
  const bl = srgbToLin(srgbChannel(hex, 5))
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * bl
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * bl
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * bl
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / 0.95047)
  const fy = f(y)
  const fz = f(z / 1.08883)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

function hueDeg(ap: number, b: number): number {
  if (ap === 0 && b === 0) return 0
  const ang = (Math.atan2(b, ap) * 180) / Math.PI
  return ang < 0 ? ang + 360 : ang
}

/** CIEDE2000. Non-hex returns 0 so a bad swatch fails the distinctness rule. */
export function deltaE00(hex1: string, hex2: string): number {
  if (!HEX.test(hex1) || !HEX.test(hex2)) return 0
  const lab1 = xyzToLab(hex1)
  const lab2 = xyzToLab(hex2)
  const c1 = Math.hypot(lab1.a, lab1.b)
  const c2 = Math.hypot(lab2.a, lab2.b)
  const cab = (c1 + c2) / 2
  const cab7 = cab ** 7
  const g = 0.5 * (1 - Math.sqrt(cab7 / (cab7 + 25 ** 7)))
  const a1p = (1 + g) * lab1.a
  const a2p = (1 + g) * lab2.a
  const c1p = Math.hypot(a1p, lab1.b)
  const c2p = Math.hypot(a2p, lab2.b)
  const h1p = hueDeg(a1p, lab1.b)
  const h2p = hueDeg(a2p, lab2.b)
  let dhp = 0
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * Math.PI) / 360)
  const lbp = (lab1.L + lab2.L) / 2
  const cbp = (c1p + c2p) / 2
  let hbp = h1p + h2p
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += hbp < 360 ? 360 : -360
    hbp /= 2
  }
  const t =
    1 -
    0.17 * Math.cos(((hbp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbp - 63) * Math.PI) / 180)
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const cbp7 = cbp ** 7
  const rc = 2 * Math.sqrt(cbp7 / (cbp7 + 25 ** 7))
  const sl = 1 + (0.015 * (lbp - 50) ** 2) / Math.sqrt(20 + (lbp - 50) ** 2)
  const sc = 1 + 0.045 * cbp
  const sh = 1 + 0.015 * cbp * t
  const rt = -Math.sin((2 * dTheta * Math.PI) / 180) * rc
  const dLp = lab2.L - lab1.L
  const dCp = c2p - c1p
  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  )
}
