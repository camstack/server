import type { ReactNode } from 'react'
import { DataTable, type DataColumn } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

type CameraRow = {
  name: string
  provider: string
  resolution: string
  status: 'Online' | 'Offline'
}

const rows: CameraRow[] = [
  { name: 'Front Door', provider: 'ONVIF', resolution: '2560×1920', status: 'Online' },
  { name: 'Backyard', provider: 'Hikvision', resolution: '1920×1080', status: 'Online' },
  { name: 'Garage', provider: 'Reolink', resolution: '3840×2160', status: 'Offline' },
  { name: 'Driveway', provider: 'RTSP', resolution: '1280×720', status: 'Online' },
]

const columns: DataColumn<CameraRow>[] = [
  {
    key: 'name',
    header: 'Camera',
    render: (r) => <span className="font-medium text-foreground">{r.name}</span>,
  },
  {
    key: 'provider',
    header: 'Provider',
    render: (r) => <span className="text-foreground-muted">{r.provider}</span>,
  },
  {
    key: 'resolution',
    header: 'Resolution',
    align: 'right',
    render: (r) => <span className="font-mono text-foreground-subtle">{r.resolution}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className={r.status === 'Online' ? 'text-success' : 'text-danger'}>{r.status}</span>
    ),
  },
]

export const CameraList = () => (
  <Frame>
    <div className="w-[640px]">
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.name} minWidthPx={560} />
    </div>
  </Frame>
)

export const Empty = () => (
  <Frame>
    <div className="w-[640px]">
      <DataTable columns={columns} rows={[]} emptyMessage="No cameras configured yet." />
    </div>
  </Frame>
)
