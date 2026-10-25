import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between text-xs">
    <span className="text-foreground-subtle">{label}</span>
    <span className="font-mono text-foreground">{value}</span>
  </div>
)

// TabsContent only renders the panel whose value matches the active tab; its
// preview shows the active panel mounted below the trigger row.
export const LivePanel = () => (
  <Frame>
    <div style={{ width: 360 }}>
      <Tabs value="live" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="live">
          <div className="space-y-2">
            <div className="aspect-video w-full rounded-md bg-surface border border-border flex items-center justify-center text-xs text-foreground-subtle">
              Garage · WebRTC 1920×1080
            </div>
            <Row label="Status" value="Online" />
            <Row label="Provider" value="Hikvision" />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </Frame>
)

export const SettingsPanel = () => (
  <Frame>
    <div style={{ width: 360 }}>
      <Tabs value="settings" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="settings">
          <div className="space-y-2">
            <Row label="Resolution" value="2560×1920" />
            <Row label="Detection" value="yolov9" />
            <Row label="Confidence" value="0.45" />
            <Row label="Zones" value="Driveway, Porch" />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  </Frame>
)
