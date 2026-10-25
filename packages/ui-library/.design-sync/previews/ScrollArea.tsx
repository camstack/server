import type { ReactNode } from 'react'
import { ScrollArea, Badge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const cameras = [
  'Front Door',
  'Backyard',
  'Garage',
  'Driveway',
  'Side Gate',
  'Living Room',
  'Patio',
  'Pool',
  'Basement',
  'Workshop',
]

export const CameraList = () => (
  <Frame>
    <ScrollArea className="h-48 w-64 rounded-lg border border-border bg-surface">
      <div className="flex flex-col">
        {cameras.map((name, i) => (
          <div
            key={name}
            className="flex items-center justify-between border-b border-border px-3 py-2.5 text-sm last:border-b-0"
          >
            <span>{name}</span>
            <Badge variant={i % 3 === 0 ? 'danger' : 'success'}>
              {i % 3 === 0 ? 'Offline' : 'Online'}
            </Badge>
          </div>
        ))}
      </div>
    </ScrollArea>
  </Frame>
)

export const EventFeed = () => (
  <Frame>
    <ScrollArea className="h-48 w-72 rounded-lg border border-border bg-surface p-2">
      <div className="flex flex-col gap-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md bg-surface-hover p-2 text-sm">
            <div className="h-9 w-12 shrink-0 rounded bg-background" />
            <div className="flex flex-col">
              <span>{['person', 'car', 'package', 'dog'][i % 4]} detected</span>
              <span className="text-xs text-foreground-muted">Backyard · 12:0{i % 10}</span>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  </Frame>
)
