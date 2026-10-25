import type { ReactNode } from 'react'
import { WidgetPanel } from '@camstack/ui-library'
import { Activity, Users, Video } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const Metric = ({ label, value, footer }: { label: string; value: ReactNode; footer?: string }) => (
  <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
    <div className="mb-1 text-[11px] uppercase tracking-wider text-foreground-subtle">{label}</div>
    <div className="text-sm font-medium text-foreground">{value}</div>
    {footer ? <div className="mt-0.5 text-[10px] text-foreground-subtle">{footer}</div> : null}
  </div>
)

export const Hero = () => (
  <Frame>
    <div className="w-72">
      <WidgetPanel
        title="Recording"
        icon={<Video className="h-3.5 w-3.5 text-foreground-subtle" />}
        headerRight={
          <span className="flex items-center gap-1 text-[10px] text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            LIVE
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Today" value="4h 12m" footer="3 segment ranges" />
          <Metric label="Retention" value="14 days" />
        </div>
      </WidgetPanel>
    </div>
  </Frame>
)

export const Collapsible = () => (
  <Frame>
    <div className="w-72 space-y-3">
      <WidgetPanel
        title="Occupancy"
        icon={<Users className="h-3.5 w-3.5 text-foreground-subtle" />}
        collapsible
        defaultOpen
      >
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Frame total" value="2 person" />
          <Metric label="Peak" value="5" footer="last hour" />
        </div>
      </WidgetPanel>
      <WidgetPanel
        title="Detections"
        icon={<Activity className="h-3.5 w-3.5 text-foreground-subtle" />}
        collapsible
        defaultOpen={false}
      >
        <div className="text-xs text-foreground-subtle">Collapsed body</div>
      </WidgetPanel>
    </div>
  </Frame>
)
