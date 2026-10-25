import { type ReactNode, useEffect, useState } from 'react'
import { AudioLevelWaveform } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 520 }}>
    {children}
  </div>
)

// AudioLevelWaveform keeps an internal ring buffer and appends one sample
// each time `currentDbfs` changes; bars are positioned by real elapsed time
// across `durationSec`. To get a populated, full-width waveform in a static
// preview we feed a sequence of levels on mount, spacing the feed to match
// the (short) display window so the bars spread across the canvas.
function LevelFeeder({
  levels,
  durationSec,
  intervalMs,
  height,
}: {
  levels: readonly number[]
  durationSec: number
  intervalMs: number
  height?: number
}) {
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    if (idx >= levels.length - 1) return
    const id = window.setTimeout(() => setIdx((i) => i + 1), intervalMs)
    return () => window.clearTimeout(id)
  }, [idx, levels.length, intervalMs])

  return (
    <AudioLevelWaveform
      currentDbfs={levels[idx] ?? null}
      durationSec={durationSec}
      maxSamples={levels.length + 4}
      height={height}
    />
  )
}

function makeLevels(n: number, base: number, amp: number, withSpikes = false): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t = i / n
    const wobble = Math.sin(t * Math.PI * 6) * amp + (Math.random() - 0.5) * 5
    let v = base + wobble
    if (withSpikes && (i === Math.floor(n * 0.35) || i === Math.floor(n * 0.7))) v = -3
    out.push(Math.max(-90, Math.min(0, v)))
  }
  return out
}

export const Hero = () => (
  <Frame>
    <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide mb-2">
      Live audio level · Backyard mic
    </div>
    <LevelFeeder levels={makeLevels(34, -32, 12)} durationSec={4} intervalMs={70} height={72} />
  </Frame>
)

export const Clipping = () => (
  <Frame>
    <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide mb-2">
      Loud event · spikes over clip threshold
    </div>
    <LevelFeeder
      levels={makeLevels(34, -22, 14, true)}
      durationSec={4}
      intervalMs={70}
      height={72}
    />
  </Frame>
)

export const Quiet = () => (
  <Frame>
    <LevelFeeder levels={makeLevels(34, -68, 6)} durationSec={4} intervalMs={70} height={64} />
  </Frame>
)
