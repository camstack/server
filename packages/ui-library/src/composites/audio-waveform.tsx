import { useUiText } from '../contexts/ui-text'
import { useRef, useEffect, useCallback, type JSX } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioWaveformProps {
  /** Raw audio samples (mono Float32Array, -1..1 range) */
  readonly samples: Float32Array | null
  /** Sample rate in Hz (for time axis labels) */
  readonly sampleRate?: number
  /** Height in pixels */
  readonly height?: number
  /** CSS class for the container */
  readonly className?: string
  /** Waveform color (CSS color string) */
  readonly color?: string
  /** Background color */
  readonly bgColor?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Canvas-based audio waveform visualization.
 * Renders a waveform from Float32Array audio samples.
 * Downsamples to pixel resolution for performance.
 */
export function AudioWaveform({
  samples,
  sampleRate = 16000,
  height = 96,
  className = '',
  color = '#3b82f6',
  bgColor = 'transparent',
}: AudioWaveformProps): JSX.Element {
  const t = useUiText()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !samples || samples.length === 0) return

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

    // Background
    if (bgColor !== 'transparent') {
      ctx.fillStyle = bgColor
      ctx.fillRect(0, 0, width, height)
    } else {
      ctx.clearRect(0, 0, width, height)
    }

    // Downsample: compute min/max per pixel column
    const samplesPerPixel = samples.length / width
    const midY = height / 2

    ctx.fillStyle = color
    ctx.globalAlpha = 0.7

    for (let px = 0; px < width; px++) {
      const startIdx = Math.floor(px * samplesPerPixel)
      const endIdx = Math.min(Math.floor((px + 1) * samplesPerPixel), samples.length)

      let min = 0
      let max = 0
      for (let i = startIdx; i < endIdx; i++) {
        const v = samples[i]!
        if (v < min) min = v
        if (v > max) max = v
      }

      const topY = midY - max * midY
      const bottomY = midY - min * midY
      const barHeight = Math.max(1, bottomY - topY)

      ctx.fillRect(px, topY, 1, barHeight)
    }

    ctx.globalAlpha = 1.0

    // Center line
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.2
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(width, midY)
    ctx.stroke()
    ctx.globalAlpha = 1.0
  }, [samples, height, color, bgColor])

  // Draw on mount and when samples change
  useEffect(() => {
    draw()
  }, [draw])

  // Redraw on resize
  useEffect(() => {
    const observer = new ResizeObserver(() => draw())
    const el = containerRef.current
    if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [draw])

  const durationMs = samples && sampleRate ? Math.round((samples.length / sampleRate) * 1000) : 0
  const durationSec = (durationMs / 1000).toFixed(1)

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas ref={canvasRef} className="w-full rounded-md" />
      {samples && samples.length > 0 && (
        <div className="absolute bottom-1 right-2 text-[10px] text-foreground-subtle/60 font-mono">
          {t(
            'uiLibrary.audioWaveform.summary',
            '{{duration}}s · {{rate}}kHz · {{samples}} samples',
            {
              duration: durationSec,
              rate: sampleRate / 1000,
              samples: samples.length.toLocaleString(),
            },
          )}
        </div>
      )}
    </div>
  )
}
