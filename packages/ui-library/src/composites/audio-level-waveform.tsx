import { useRef, useEffect, useCallback, useState, type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioLevelSample {
  readonly dbfs: number
  readonly timestamp: number
}

export interface AudioLevelWaveformProps {
  /** Current dBFS level — push a new value to append to the internal ring buffer. */
  readonly currentDbfs: number | null
  /** How many seconds of history to display (default 30) */
  readonly durationSec?: number
  /** Max samples to keep in memory (default 120 ≈ 60s at 2 samples/s) */
  readonly maxSamples?: number
  /** Height in pixels (default 64) */
  readonly height?: number
  /** CSS class for the container */
  readonly className?: string
  /** Bar color (CSS) */
  readonly color?: string
  /** Clipping color when dBFS > threshold (default red) */
  readonly clipColor?: string
  /** dBFS threshold for clipping color (default -6) */
  readonly clipThreshold?: number
  /** Min dBFS to display (default -96) */
  readonly minDbfs?: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Canvas-based live audio level waveform with internal state.
 *
 * Receives `currentDbfs` — each time it changes, a new sample is appended
 * to an internal ring buffer and the canvas is redrawn. The component
 * manages its own history, so callers just push the latest dBFS value.
 *
 * Designed to be fed from the `pipeline.audio-inference-result` event
 * (each chunk, ~0.5s, produces one sample via `frame.level.dbfs`).
 */
export function AudioLevelWaveform({
  currentDbfs,
  durationSec = 30,
  maxSamples = 120,
  height = 64,
  className = '',
  color = '#10b981',
  clipColor = '#ef4444',
  clipThreshold = -6,
  minDbfs = -96,
}: AudioLevelWaveformProps): JSX.Element {
  const t = useUiText()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [samples, setSamples] = useState<readonly AudioLevelSample[]>([])

  // Append new sample when currentDbfs changes (skip null)
  useEffect(() => {
    if (currentDbfs === null) return
    setSamples((prev) => {
      const next = [...prev, { dbfs: currentDbfs, timestamp: Date.now() }]
      return next.length > maxSamples ? next.slice(-maxSamples) : next
    })
  }, [currentDbfs, maxSamples])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const width = container.clientWidth
    if (width === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    if (samples.length === 0) return

    const now = samples[samples.length - 1]!.timestamp
    const windowMs = durationSec * 1000
    const startTime = now - windowMs

    // Filter to visible window
    const visible = samples.filter((s) => s.timestamp >= startTime)
    if (visible.length === 0) return

    // Each sample is one bar; bar width based on time density
    const barWidth = Math.max(1, Math.floor(width / (durationSec * 2)))
    const dbRange = Math.abs(minDbfs)

    for (const sample of visible) {
      const timeOffset = sample.timestamp - startTime
      const x = Math.floor((timeOffset / windowMs) * width)

      const clamped = Math.max(minDbfs, Math.min(0, sample.dbfs))
      const normalized = (clamped - minDbfs) / dbRange
      const barHeight = Math.max(1, normalized * height)

      const isClipping = sample.dbfs >= clipThreshold
      ctx.fillStyle = isClipping ? clipColor : color
      ctx.globalAlpha = 0.8
      ctx.fillRect(x, height - barHeight, barWidth, barHeight)
    }

    ctx.globalAlpha = 1.0

    // Clip threshold line
    const thresholdY = height - ((clipThreshold - minDbfs) / dbRange) * height
    ctx.strokeStyle = clipColor
    ctx.globalAlpha = 0.25
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, thresholdY)
    ctx.lineTo(width, thresholdY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1.0
  }, [samples, durationSec, height, color, clipColor, clipThreshold, minDbfs])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const observer = new ResizeObserver(() => draw())
    const el = containerRef.current
    if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [draw])

  const latestDbfs = samples.length > 0 ? samples[samples.length - 1]!.dbfs : null

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas ref={canvasRef} className="w-full rounded-md" />
      <div className="absolute top-1 left-2 text-[9px] text-foreground-subtle/50 font-mono">
        {durationSec}s
      </div>
      {latestDbfs !== null && (
        <div className="absolute bottom-1 right-2 text-[9px] text-foreground-subtle/50 font-mono">
          {t(
            'uiLibrary.audioLevelWaveform.readout',
            {
              one: '{{dbfs}} dBFS · {{count}} sample',
              other: '{{dbfs}} dBFS · {{count}} samples',
            },
            { dbfs: latestDbfs.toFixed(1), count: samples.length },
          )}
        </div>
      )}
    </div>
  )
}
