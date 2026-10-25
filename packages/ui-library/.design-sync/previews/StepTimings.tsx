import type { ReactNode } from 'react'
import { StepTimings } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="w-72">
      <StepTimings
        timings={{
          decode: 4.2,
          'object-detect': 38.7,
          'face-recognize': 21.5,
          'plate-read': 12.1,
          encode: 3.4,
        }}
        totalMs={79.9}
      />
    </div>
  </Frame>
)

export const NoTotal = () => (
  <Frame>
    <div className="w-72">
      <StepTimings
        timings={{
          'motion-gate': 1.8,
          'object-detect': 44.3,
          classify: 9.6,
        }}
      />
    </div>
  </Frame>
)
