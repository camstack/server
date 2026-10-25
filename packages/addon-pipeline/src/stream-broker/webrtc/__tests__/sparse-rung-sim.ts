/**
 * A deterministic model of one rung as the broker SENDS it and the client
 * REPORTS it — the shape that froze the ladder on device 104 (2026-09-25):
 * a static indoor sub stream at ~41 kbps between IDRs with an IDR every ~4 s,
 * reported by the player as Δ bytesReceived over its own 2 s getStats window.
 *
 * Test-only. The numbers are the live ones from `.superpowers/sdd/hall-scaleup.md`.
 */
import type { SendHistory } from '../delivery-meter.js'

export interface RungShape {
  /** Rate of the P-frames between IDRs, kbps. */
  readonly pFrameKbps: number
  /** Size of one IDR access unit, bytes. */
  readonly idrBytes: number
  /** Time between IDRs, ms. */
  readonly idrIntervalMs: number
  readonly fps: number
}

/** Device 104 `native:sub`: 41 kbps between IDRs, IDR every 4021 ms. */
export const HALL_SUB: RungShape = {
  pFrameKbps: 41,
  idrBytes: 30_000,
  idrIntervalMs: 4_021,
  fps: 25,
}

export interface SentFrame {
  readonly at: number
  readonly bytes: number
}

/** Every frame the broker puts on the wire in `[from, to)`. */
export function framesBetween(shape: RungShape, from: number, to: number): readonly SentFrame[] {
  const frameMs = 1000 / shape.fps
  const pBytes = (shape.pFrameKbps * 1000) / 8 / shape.fps
  const out: SentFrame[] = []
  const first = Math.ceil(from / frameMs)
  for (let i = first; i * frameMs < to; i += 1) {
    const at = i * frameMs
    const idrIndex = Math.floor(at / shape.idrIntervalMs)
    const prevAt = (i - 1) * frameMs
    const isIdr = i === 0 || Math.floor(prevAt / shape.idrIntervalMs) !== idrIndex
    out.push({ at, bytes: isIdr ? shape.idrBytes : pBytes })
  }
  return out
}

/**
 * The player's report for the window ending at `clientAt` — Δ bytes received
 * over its 2 s getStats window × 8 / Δt — scaled by `deliveredFraction` (1 =
 * everything landed).
 */
export function clientReportKbps(
  shape: RungShape,
  clientAt: number,
  windowMs: number,
  deliveredFraction: number,
): number {
  const frames = framesBetween(shape, clientAt - windowMs, clientAt)
  const bytes = frames.reduce((sum, f) => sum + f.bytes, 0) * deliveredFraction
  return Math.round((bytes * 8) / windowMs)
}

/** Record every frame sent in `[from, to)` into the broker's history. */
export function recordSent(history: SendHistory, shape: RungShape, from: number, to: number): void {
  for (const f of framesBetween(shape, from, to)) history.record(f.bytes, f.at)
}
