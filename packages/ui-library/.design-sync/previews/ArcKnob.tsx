import type { ReactNode } from 'react'
import { ArcKnob } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

/** A sized, relative host with a faint reference ring so the knob's arc
 *  position reads. Box 150px → centre 75, ring radius 64 → knobTopPx = 1. */
const Gauge = ({ fraction, color }: { fraction: number; color: string }) => (
  <div className="relative" style={{ width: 150, height: 150 }}>
    <div
      className="absolute rounded-full border-2 border-dashed border-border"
      style={{ inset: 11 }}
    />
    <ArcKnob fraction={fraction} color={color} knobTopPx={1} />
  </div>
)

export const Hero = () => (
  <Frame>
    <Gauge fraction={0.6} color="#f59e0b" />
  </Frame>
)

export const Positions = () => (
  <Frame>
    <div className="flex gap-4">
      <Gauge fraction={0} color="#f87171" />
      <Gauge fraction={0.5} color="#38bdf8" />
      <Gauge fraction={1} color="#34d399" />
    </div>
  </Frame>
)
