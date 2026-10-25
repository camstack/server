import type { ReactNode } from 'react'
import { Sidebar } from '@camstack/ui-library'
import { Camera, Bell, LayoutGrid, Video, Cpu, Settings, HelpCircle, LogOut } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground rounded-lg" style={{ height: 420 }}>
    {children}
  </div>
)

const Logo = () => (
  <div className="flex items-center gap-2 px-1 py-1">
    <div className="h-5 w-5 rounded bg-primary/80" />
    <span className="text-xs font-semibold text-foreground">CamStack</span>
  </div>
)

const sections = [
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
]

const footer = [
  { label: 'Help', icon: HelpCircle, href: '#' },
  { label: 'Sign out', icon: LogOut, href: '#' },
]

export const Hero = () => (
  <Frame>
    <div style={{ width: 176, height: 420 }}>
      <Sidebar logo={<Logo />} sections={sections} footer={footer} />
    </div>
  </Frame>
)

export const NoFooter = () => (
  <Frame>
    <div style={{ width: 176, height: 420 }}>
      <Sidebar logo={<Logo />} sections={sections} />
    </div>
  </Frame>
)

export const SingleSection = () => (
  <Frame>
    <div style={{ width: 176, height: 420 }}>
      <Sidebar
        sections={[
          {
            items: [
              { label: 'Cameras', icon: Camera, href: '#', active: true },
              { label: 'Events', icon: Bell, href: '#', badge: '3' },
              { label: 'Settings', icon: Settings, href: '#' },
            ],
          },
        ]}
      />
    </div>
  </Frame>
)
