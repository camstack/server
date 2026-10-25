import type { ReactNode } from 'react'
import { AppShell, DeviceCard } from '@camstack/ui-library'
import { Camera, Bell, LayoutGrid, Video, Cpu, Settings, Plus, RefreshCw } from 'lucide-react'

// AppShell roots with `flex h-screen`; pin a fixed-height, clipped viewport so
// the full layout (sidebar + header + content) is captured inside the card.
const Frame = ({ children }: { children: ReactNode }) => (
  <div
    className="dark bg-background text-foreground rounded-lg overflow-hidden"
    style={{ width: 720, height: 460 }}
  >
    {children}
  </div>
)

const Logo = () => (
  <div className="flex items-center gap-2 px-1 py-1">
    <div className="h-5 w-5 rounded bg-primary/80" />
    <span className="text-xs font-semibold text-foreground">CamStack</span>
  </div>
)

const sidebar = {
  logo: <Logo />,
  sections: [
    {
      label: 'Monitor',
      items: [
        { label: 'Cameras', icon: Camera, href: '#', active: true },
        { label: 'Grids', icon: LayoutGrid, href: '#' },
        { label: 'Events', icon: Bell, href: '#', badge: 12 },
        { label: 'Recordings', icon: Video, href: '#' },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Pipelines', icon: Cpu, href: '#' },
        { label: 'Settings', icon: Settings, href: '#' },
      ],
    },
  ],
}

const HeaderActions = () => (
  <>
    <button className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground">
      <RefreshCw className="h-3 w-3" /> Refresh
    </button>
    <button className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground">
      <Plus className="h-3 w-3" /> Add camera
    </button>
  </>
)

export const Hero = () => (
  <Frame>
    <AppShell
      sidebar={sidebar}
      header={{
        breadcrumbs: [{ label: 'Monitor', href: '#' }, { label: 'Cameras' }],
        actions: <HeaderActions />,
      }}
    >
      <div className="grid grid-cols-2 gap-3" style={{ maxWidth: 480 }}>
        <DeviceCard
          title="Front Door"
          subtitle="Reolink · 2560×1920"
          status="online"
          badges={[{ label: 'main' }]}
        />
        <DeviceCard
          title="Backyard"
          subtitle="ONVIF · Recording"
          status="online"
          badges={[{ label: '1080p' }]}
        />
        <DeviceCard title="Garage" subtitle="RTSP · offline" status="offline" />
        <DeviceCard title="Driveway" subtitle="Hikvision" status="warning" />
      </div>
    </AppShell>
  </Frame>
)

export const DeepBreadcrumb = () => (
  <Frame>
    <AppShell
      sidebar={sidebar}
      header={{
        breadcrumbs: [
          { label: 'System', href: '#' },
          { label: 'Pipelines', href: '#' },
          { label: 'Object Detection' },
        ],
      }}
    >
      <div className="rounded-lg border border-border bg-surface p-4">
        <h1 className="text-sm font-semibold text-foreground">Object Detection</h1>
        <p className="mt-1 text-xs text-foreground-muted">arcface · stage 3 · 4 active streams</p>
      </div>
    </AppShell>
  </Frame>
)
