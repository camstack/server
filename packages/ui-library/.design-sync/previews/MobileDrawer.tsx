import type { ReactNode } from 'react'
import { MobileDrawer } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

// MobileDrawer is `fixed inset-y-0 left-0` — it pins to the viewport edge. The
// host gives the card a footprint; the open drawer panel paints over it.
const Host = ({ children }: { children: ReactNode }) => (
  <div className="relative h-80 w-full overflow-hidden rounded-md border border-border bg-background">
    {children}
  </div>
)

export const Hero = () => (
  <Frame>
    <Host>
      <MobileDrawer open onClose={noop}>
        <div className="flex flex-col h-full">
          <div className="px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-foreground">CamStack</span>
          </div>
          <nav className="flex-1 p-2 space-y-1">
            {[
              ['Cameras', true],
              ['Grids', false],
              ['Events', false],
              ['Accessories', false],
              ['Settings', false],
            ].map(([label, active]) => (
              <div
                key={label as string}
                className={
                  active
                    ? 'rounded-md bg-primary/15 px-3 py-2 text-sm font-medium text-primary'
                    : 'rounded-md px-3 py-2 text-sm text-foreground-muted hover:bg-surface-hover'
                }
              >
                {label}
              </div>
            ))}
          </nav>
        </div>
      </MobileDrawer>
    </Host>
  </Frame>
)

export const CameraList = () => (
  <Frame>
    <Host>
      <MobileDrawer open onClose={noop} width="w-72">
        <div className="flex flex-col h-full">
          <div className="px-4 py-3 border-b border-border text-sm font-semibold">Cameras</div>
          <div className="flex-1 p-2 space-y-1">
            {[
              ['Front Door', 'Recording'],
              ['Backyard', 'Online'],
              ['Garage', 'Idle'],
              ['Driveway', 'Offline'],
            ].map(([name, state]) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-surface-hover"
              >
                <span className="text-foreground">{name}</span>
                <span className="text-[10px] text-foreground-subtle">{state}</span>
              </div>
            ))}
          </div>
        </div>
      </MobileDrawer>
    </Host>
  </Frame>
)
