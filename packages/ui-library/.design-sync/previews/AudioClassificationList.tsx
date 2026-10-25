import type { ReactNode } from 'react'
import { AudioClassificationList } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ width: 460 }}>
    {children}
  </div>
)

const classifications = [
  { className: 'Speech', score: 0.91 },
  { className: 'Dog bark', score: 0.74 },
  { className: 'Doorbell', score: 0.58 },
  { className: 'Vehicle', score: 0.41 },
  { className: 'Footsteps', score: 0.33 },
  { className: 'Glass breaking', score: 0.27 },
  { className: 'Wind', score: 0.19 },
  { className: 'Silence', score: 0.08 },
]

export const Hero = () => (
  <Frame>
    <AudioClassificationList classifications={classifications} inferenceMs={42.7} maxItems={6} />
  </Frame>
)

export const FullList = () => (
  <Frame>
    <AudioClassificationList classifications={classifications} inferenceMs={61.2} />
  </Frame>
)

export const Processing = () => (
  <Frame>
    <AudioClassificationList classifications={[]} processing />
  </Frame>
)

export const Empty = () => (
  <Frame>
    <AudioClassificationList classifications={[]} />
  </Frame>
)
