// The fixed clock every fixture and the runner share (the runner freezes the page clock one minute later).
export const MINUTE = 60_000
export const H = 60 * MINUTE
export const D = 24 * H
export const NOW = Date.UTC(2026, 9, 9, 9, 30)
export const iso = (ms: number): string => new Date(ms).toISOString()
