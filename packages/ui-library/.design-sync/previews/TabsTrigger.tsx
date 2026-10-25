import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

// TabsTrigger only renders inside <Tabs>; the active trigger gets a primary
// underline + foreground text, inactive triggers are muted. Each story sets a
// different active value to show both states side by side.
const TriggerSet = ({ active }: { active: string }) => (
  <div style={{ width: 360 }}>
    <Tabs value={active} onValueChange={() => {}}>
      <TabsList>
        <TabsTrigger value="live">Live</TabsTrigger>
        <TabsTrigger value="events">Events</TabsTrigger>
        <TabsTrigger value="settings" disabled>
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value={active}>
        <div className="text-xs text-foreground-subtle pt-1">
          Active tab: <span className="text-foreground font-medium">{active}</span>
        </div>
      </TabsContent>
    </Tabs>
  </div>
)

export const ActiveLive = () => (
  <Frame>
    <TriggerSet active="live" />
  </Frame>
)

export const ActiveEvents = () => (
  <Frame>
    <TriggerSet active="events" />
  </Frame>
)
