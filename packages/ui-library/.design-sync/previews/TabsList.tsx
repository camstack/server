import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

// TabsList only renders inside <Tabs>; its preview is the full composition,
// showing the row of triggers it lays out under a bottom border.
export const Hero = () => (
  <Frame>
    <div style={{ width: 360 }}>
      <Tabs value="live" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="live">
          <div className="aspect-video w-full rounded-md bg-surface border border-border flex items-center justify-center text-xs text-foreground-subtle">
            Front Door · Live
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </Frame>
)

export const ManyTabs = () => (
  <Frame>
    <div style={{ width: 360 }}>
      <Tabs value="clips" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="clips">Clips</TabsTrigger>
          <TabsTrigger value="zones">Zones</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="clips">
          <div className="text-xs text-foreground-subtle pt-1">14 clips · Backyard · last 24h</div>
        </TabsContent>
      </Tabs>
    </div>
  </Frame>
)
