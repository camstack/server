/**
 * Fixture page for the layout-A hero scenes. Not an admin route: `ui:shots`
 * mounts it when the path is `/hero-scenes-preview`. Every scene id is drawn in
 * a HeroCardA and in a DeviceRow (mini scene); `?view=rows` draws the rows only.
 */
import {
  Badge,
  DeviceRow,
  HeroCardA,
  HeroScene,
  type HeroSceneId,
  type HeroSceneParams,
  ThemeProvider,
} from '@camstack/ui-library'
import type { ReactElement } from 'react'

interface Case {
  readonly scene: HeroSceneId
  readonly state: string
  readonly title: string
  readonly params?: HeroSceneParams
}

const CASES: readonly Case[] = [
  { scene: 'ac', state: 'cool', title: 'Living room AC' },
  { scene: 'ac', state: 'heat', title: 'Bedroom AC' },
  { scene: 'ac', state: 'dry', title: 'Office AC' },
  { scene: 'ac', state: 'fan', title: 'Hall AC' },
  { scene: 'ac', state: 'off', title: 'Guest AC' },
  { scene: 'thermostat', state: 'heat', title: 'Thermostat' },
  { scene: 'heater', state: 'on', title: 'Heater', params: { timer: true, level: 0.6 } },
  { scene: 'fan', state: 'on', title: 'Fan' },
  { scene: 'washer', state: 'run', title: 'Washer' },
  { scene: 'dryer', state: 'run', title: 'Dryer' },
  { scene: 'dishwasher', state: 'run', title: 'Dishwasher' },
  { scene: 'pet-fountain', state: 'on', title: 'Pet fountain' },
  { scene: 'pet-feeder', state: 'on', title: 'Pet feeder' },
  { scene: 'vacuum', state: 'cleaning', title: 'Vacuum' },
  { scene: 'lawn-mower', state: 'mowing', title: 'Lawn mower' },
  { scene: 'tv', state: 'on', title: 'TV' },
  { scene: 'speaker', state: 'playing', title: 'Speaker' },
  { scene: 'camera', state: 'recording', title: 'Front door camera' },
  { scene: 'light', state: 'on', title: 'Light' },
  { scene: 'cover', state: 'closing', title: 'Shutter', params: { level: 0.6 } },
  { scene: 'lock', state: 'locked', title: 'Front door lock' },
  { scene: 'alarm', state: 'armed', title: 'Alarm' },
  { scene: 'siren', state: 'sounding', title: 'Siren' },
  {
    scene: 'sensor-sparkline',
    state: '',
    title: 'Temperature sensor',
    params: { points: [18, 19, 19.5, 21, 20.5, 22, 23, 22.5, 24] },
  },
  { scene: 'contact', state: 'open', title: 'Window contact' },
  { scene: 'presence', state: 'detected', title: 'Presence' },
  { scene: 'weather', state: 'rain', title: 'Weather station' },
  { scene: 'plug', state: 'on', title: 'Smart plug' },
  { scene: 'button', state: 'pressed', title: 'Button' },
  { scene: 'update', state: 'available', title: 'Firmware update' },
  { scene: 'control-dial', state: 'on', title: 'Dial' },
  { scene: 'event-stream', state: 'on', title: 'Event source' },
  { scene: 'gateway', state: 'online', title: 'Gateway' },
  { scene: 'generic', state: 'on', title: 'Generic command' },
]

const TILES_L = [
  { label: 'Indoor', value: '26.1°' },
  { label: 'Humidity', value: '58%' },
]
const TILES_R = [{ label: 'Today', value: '3.4 kWh' }]

export function HeroScenesPreview(): ReactElement {
  const rowsOnly = new URLSearchParams(window.location.search).get('view') === 'rows'
  return (
    <ThemeProvider>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 bg-background p-4">
        <div
          className={rowsOnly ? 'hidden' : 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3'}
        >
          {CASES.map((c) => (
            <HeroCardA
              key={`${c.scene}-${c.state}-${c.title}`}
              title={c.title}
              chips={<Badge>{c.state === '' ? 'live' : c.state}</Badge>}
              scene={
                <HeroScene
                  scene={c.scene}
                  state={c.state}
                  {...c.params}
                  leftTiles={TILES_L}
                  rightTiles={TILES_R}
                >
                  <span className="text-2xl font-semibold tabular-nums">24°</span>
                </HeroScene>
              }
            />
          ))}
        </div>
        <div className="rounded-2xl border border-border bg-surface">
          {CASES.map((c) => (
            <DeviceRow
              key={`row-${c.scene}-${c.state}-${c.title}`}
              scene={{ scene: c.scene, state: c.state, ...c.params }}
              name={c.title}
              status={`${c.scene} · ${c.state === '' ? 'live' : c.state}`}
              control={<Badge>{c.state === '' ? 'live' : c.state}</Badge>}
              fact={<Badge>820 W</Badge>}
            />
          ))}
        </div>
      </div>
    </ThemeProvider>
  )
}
