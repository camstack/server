import type { ReactNode } from 'react'
import { Skeleton } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="flex flex-col gap-2 w-64">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="aspect-video w-full" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-32" />
    </div>
  </Frame>
)

export const CameraCardLoading = () => (
  <Frame>
    <div className="flex gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="w-40 rounded-lg border border-border bg-surface p-3">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="mt-2 h-3 w-20" />
          <Skeleton className="mt-1.5 h-3 w-14" />
        </div>
      ))}
    </div>
  </Frame>
)

export const ListLoading = () => (
  <Frame>
    <div className="flex flex-col gap-3 w-64">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  </Frame>
)
