import type { ReactNode } from 'react'
import { HoverZoomImage } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

// Tiny inline SVG data-URIs so the thumbnails render a real image (no network).
const tile = (label: string, hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'><rect width='160' height='120' fill='hsl(${hue},35%,22%)'/><rect x='0' y='84' width='160' height='36' fill='rgba(0,0,0,0.45)'/><text x='8' y='106' font-family='monospace' font-size='13' fill='#e5e7eb'>${label}</text></svg>`,
  )}`

export const SnapshotRow = () => (
  <Frame>
    <div className="space-y-2 w-72">
      <div className="text-[10px] uppercase tracking-wider text-foreground-subtle">
        Device snapshots
      </div>
      {[
        { name: 'Front Door', src: tile('Front Door', 210) },
        { name: 'Backyard', src: tile('Backyard', 140) },
        { name: 'Driveway', src: tile('Driveway', 30) },
      ].map((c) => (
        <div key={c.name} className="flex items-center gap-2 text-xs">
          <HoverZoomImage src={c.src} alt={c.name} caption={`${c.name} · live snapshot`} />
          <span className="text-foreground">{c.name}</span>
          <span className="ml-auto text-foreground-subtle">2560×1920</span>
        </div>
      ))}
    </div>
  </Frame>
)

export const EmptyAndImage = () => (
  <Frame>
    <div className="flex items-center gap-8 py-3">
      <div className="flex items-center gap-2">
        <HoverZoomImage src={tile('Garage', 280)} alt="Garage" />
        <span className="text-xs text-foreground">Garage · with image</span>
      </div>
      <div className="flex items-center gap-2">
        <HoverZoomImage src={null} alt="Side Gate" placeholder="No snapshot yet" />
        <span className="text-xs text-foreground-subtle">Side Gate · placeholder</span>
      </div>
    </div>
  </Frame>
)
