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

const DeviceTabs = ({ active }: { active: string }) => (
  <div style={{ width: 360 }}>
    <Tabs value={active} onValueChange={() => {}}>
      <TabsList>
        <TabsTrigger value="live">Live</TabsTrigger>
        <TabsTrigger value="events">Events</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>

      <TabsContent value="live">
        <div className="space-y-2">
          <div className="aspect-video w-full rounded-md bg-surface border border-border flex items-center justify-center text-xs text-foreground-subtle">
            Front Door · WebRTC 1920×1080
          </div>
          <Row label="Status" value="Recording" />
          <Row label="Provider" value="ONVIF" />
        </div>
      </TabsContent>

      <TabsContent value="events">
        <div className="space-y-1.5">
          {[
            ['person', '12:04:31'],
            ['car', '11:58:02'],
            ['package', '11:40:17'],
          ].map(([d, t]) => (
            <div key={t} className="flex items-center justify-between text-xs">
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                {d}
              </span>
              <span className="font-mono text-foreground-subtle">{t}</span>
            </div>
          ))}
        </div>
      </TabsContent>

      <TabsContent value="settings">
        <div className="space-y-2">
          <Row label="Resolution" value="2560×1920" />
          <Row label="Detection" value="yolov9" />
          <Row label="Confidence" value="0.45" />
        </div>
      </TabsContent>
    </Tabs>
  </div>
)

export const Hero = () => (
  <Frame>
    <DeviceTabs active="live" />
  </Frame>
)

export const EventsSelected = () => (
  <Frame>
    <DeviceTabs active="events" />
  </Frame>
)

export const SettingsSelected = () => (
  <Frame>
    <DeviceTabs active="settings" />
  </Frame>
)
