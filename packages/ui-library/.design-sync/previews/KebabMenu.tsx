import type { ReactNode } from 'react'
import { KebabMenu } from '@camstack/ui-library'
import { Camera, RotateCw, Download, Trash2 } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const items = [
  { id: 'snapshot', label: 'Take snapshot', icon: Camera, onClick: () => {} },
  { id: 'reboot', label: 'Reboot device', icon: RotateCw, onClick: () => {} },
  {
    id: 'export',
    label: 'Export config',
    icon: Download,
    description: 'Download as JSON',
    onClick: () => {},
  },
  {
    id: 'delete',
    label: 'Delete camera',
    icon: Trash2,
    danger: true,
    separatorBefore: true,
    onClick: () => {},
  },
]

export const Trigger = () => (
  <Frame>
    <KebabMenu items={items} title="Device actions" />
  </Frame>
)

export const InDeviceRow = () => (
  <Frame>
    <div className="flex items-center justify-between gap-4 rounded border border-border px-3 py-2 w-96">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-foreground">Garage</span>
        <span className="text-xs text-foreground-subtle">Hikvision · Online</span>
      </div>
      <KebabMenu items={items} />
    </div>
  </Frame>
)

export const WithDisabledItem = () => (
  <Frame>
    <KebabMenu
      items={[
        { id: 'snapshot', label: 'Take snapshot', icon: Camera, onClick: () => {} },
        {
          id: 'reboot',
          label: 'Reboot device',
          icon: RotateCw,
          disabled: true,
          onClick: () => {},
        },
      ]}
    />
  </Frame>
)
