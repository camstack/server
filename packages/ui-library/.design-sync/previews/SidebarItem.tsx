import type { ReactNode } from 'react'
import { SidebarItem } from '@camstack/ui-library'
import { Camera, Bell, LayoutGrid, Settings } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <nav
      className="bg-surface border border-border rounded-md p-1 flex flex-col gap-0.5"
      style={{ width: 176 }}
    >
      <SidebarItem label="Cameras" icon={Camera} href="#" active />
      <SidebarItem label="Events" icon={Bell} href="#" badge={12} />
      <SidebarItem label="Grids" icon={LayoutGrid} href="#" />
      <SidebarItem label="Settings" icon={Settings} href="#" />
    </nav>
  </Frame>
)

export const Active = () => (
  <Frame>
    <nav className="bg-surface border border-border rounded-md p-1" style={{ width: 176 }}>
      <SidebarItem label="Cameras" icon={Camera} href="#" active />
    </nav>
  </Frame>
)

export const WithBadge = () => (
  <Frame>
    <nav className="bg-surface border border-border rounded-md p-1" style={{ width: 176 }}>
      <SidebarItem label="Events" icon={Bell} href="#" badge="99+" />
    </nav>
  </Frame>
)

export const Inactive = () => (
  <Frame>
    <nav className="bg-surface border border-border rounded-md p-1" style={{ width: 176 }}>
      <SidebarItem label="Settings" icon={Settings} href="#" />
    </nav>
  </Frame>
)
