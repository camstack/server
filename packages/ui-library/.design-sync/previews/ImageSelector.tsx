import type { ReactNode } from 'react'
import { ImageSelector } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

const REFERENCE_IMAGES = [
  { id: 'person', filename: 'person.jpg', sizeKB: 142 },
  { id: 'car', filename: 'car.jpg', sizeKB: 98 },
  { id: 'package', filename: 'package.jpg', sizeKB: 64 },
  { id: 'dog', filename: 'dog.jpg', sizeKB: 73 },
] as const

export const Hero = () => (
  <Frame>
    <div className="space-y-2 w-96">
      <div className="text-[10px] uppercase tracking-wider text-foreground-subtle">
        Reference image
      </div>
      <ImageSelector
        images={REFERENCE_IMAGES}
        selectedFilename="person.jpg"
        onSelect={noop}
        onUpload={noop}
      />
    </div>
  </Frame>
)

export const WithUpload = () => (
  <Frame>
    <div className="space-y-2 w-96">
      <div className="text-[10px] uppercase tracking-wider text-foreground-subtle">
        Audio sample
      </div>
      <ImageSelector
        images={[
          { id: 'doorbell', filename: 'doorbell.wav', sizeKB: 220 },
          { id: 'glass-break', filename: 'glass-break.wav', sizeKB: 310 },
          { id: 'dog-bark', filename: 'dog-bark.wav', sizeKB: 188 },
        ]}
        selectedFilename="custom-upload"
        uploadedName="front-door-2026-06-20.wav"
        uploadLabel="Upload sample…"
        accept="audio/*"
        onSelect={noop}
        onUpload={noop}
      />
    </div>
  </Frame>
)
