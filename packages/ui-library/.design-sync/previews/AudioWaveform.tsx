import type { ReactNode } from 'react'
import { AudioWaveform } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 520 }}>
    {children}
  </div>
)

// 1s of 16kHz mono audio: speech-like burst envelope + noise floor.
function makeSamples(seconds: number, rate = 16000): Float32Array {
  const n = Math.floor(seconds * rate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = Math.exp(-Math.pow((t - seconds / 2) * 3, 2)) // bell envelope
    const tone = Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 480 * t)
    const noise = (Math.random() - 0.5) * 0.15
    out[i] = Math.max(-1, Math.min(1, env * tone * 0.7 + noise))
  }
  return out
}

const speech = makeSamples(1.0)
const quiet = (() => {
  const s = new Float32Array(8000)
  for (let i = 0; i < s.length; i++) s[i] = (Math.random() - 0.5) * 0.08
  return s
})()

export const Hero = () => (
  <Frame>
    <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide mb-2">
      Doorbell capture · Front Door
    </div>
    <AudioWaveform samples={speech} sampleRate={16000} height={110} />
  </Frame>
)

export const Quiet = () => (
  <Frame>
    <AudioWaveform samples={quiet} sampleRate={16000} height={90} color="#10b981" />
  </Frame>
)

export const AmberOnDark = () => (
  <Frame>
    <AudioWaveform samples={speech} sampleRate={16000} height={110} color="#f59e0b" />
  </Frame>
)
