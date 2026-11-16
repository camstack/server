/**
 * The UniFi controller client for a LOCAL account (username + password): the classic Network API
 * (`/api/s/<site>/…`) over a {@link UnifiSession}, on a UniFi OS console or a legacy controller.
 * Polled; the last-known tables back the synchronous getters. Unlike the API-key Integration
 * API, the classic API can switch PoE on and off (`port_overrides`), names the wired client on
 * each port (`stat/sta` `sw_mac` + `sw_port`) and reports PoE power and temperatures.
 */
import { z } from 'zod'
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiInfraPort,
  UnifiInfraSnapshot,
  UnifiInfraState,
} from './unifi-client-contract.js'
import { classifyUnifiInfra } from './unifi-device-kind.js'
import { UnifiApiError, UnifiSiteNotFoundError } from './unifi-errors.js'
import type { UnifiSession } from './unifi-session.js'

const siteSchema = z.object({
  name: z.string(),
  desc: z.string().optional(),
})

const numeric = z.union([z.string(), z.number()]).optional()

const portSchema = z.object({
  port_idx: z.number(),
  up: z.boolean().optional(),
  speed: z.number().optional(),
  poe_caps: z.number().optional(),
  port_poe: z.boolean().optional(),
  poe_enable: z.boolean().optional(),
  poe_mode: z.string().optional(),
  poe_power: numeric,
  poe_voltage: numeric,
  poe_current: numeric,
})

/** One `port_overrides` entry, kept whole: every field the controller sent is sent back. */
const portOverrideSchema = z.looseObject({ port_idx: z.number() })
type PortOverride = z.infer<typeof portOverrideSchema>

const deviceSchema = z.object({
  _id: z.string(),
  mac: z.string(),
  type: z.string().optional(),
  name: z.string().optional(),
  model: z.string().optional(),
  state: z.number().optional(),
  uptime: z.number().optional(),
  'system-stats': z.object({ cpu: numeric }).optional(),
  general_temperature: z.number().optional(),
  temperatures: z.array(z.object({ name: z.string().optional(), value: z.number() })).optional(),
  num_sta: z.number().optional(),
  port_table: z.array(portSchema).optional(),
  led_override: z.string().optional(),
  port_overrides: z.array(portOverrideSchema).optional(),
})
type ClassicDevice = z.infer<typeof deviceSchema>

const clientSchema = z.object({
  mac: z.string(),
  hostname: z.string().optional(),
  name: z.string().optional(),
  ip: z.string().optional(),
  is_wired: z.boolean().optional(),
  sw_mac: z.string().optional(),
  sw_port: z.number().optional(),
})
type ClassicClient = z.infer<typeof clientSchema>

/** The PoE mode a port is switched to. `auto` is the controller's own "on". */
export type UnifiPoeMode = 'auto' | 'off'

/** The classic API's numeric device state. */
function mapState(state: number | undefined): UnifiInfraState {
  switch (state) {
    case 1:
      return 'online'
    case 0:
    case 6:
      return 'offline'
    case 2:
      return 'pending'
    case 4:
      return 'upgrading'
    case 5:
    case 7:
      return 'adopting'
    default:
      return 'unknown'
  }
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

function cpuTemperature(device: ClassicDevice): number | null {
  if (device.general_temperature !== undefined) return device.general_temperature
  const cpu = device.temperatures?.find((t) => (t.name ?? '').toLowerCase().includes('cpu'))
  return cpu?.value ?? null
}

/** The Integration API `features` a classic device `type` corresponds to, for the classifier. */
function featuresOfType(type: string | undefined): readonly string[] {
  if (type === 'uap') return ['accessPoint']
  if (type === 'usw') return ['switching']
  return []
}

/** The wired client on each `<switch mac>:<port>`. */
function wiredClientIndex(clients: readonly ClassicClient[]): Map<string, ClassicClient> {
  const index = new Map<string, ClassicClient>()
  for (const c of clients) {
    if (c.sw_mac === undefined || c.sw_port === undefined || c.is_wired === false) continue
    index.set(`${c.sw_mac.toLowerCase()}:${c.sw_port}`, c)
  }
  return index
}

function clientLabel(client: ClassicClient): string | null {
  const label = client.name ?? client.hostname ?? ''
  return label.length > 0 ? label : null
}

function toPort(
  device: ClassicDevice,
  p: z.infer<typeof portSchema>,
  wired: ReadonlyMap<string, ClassicClient>,
): UnifiInfraPort {
  const client = wired.get(`${device.mac.toLowerCase()}:${p.port_idx}`)
  const mA = toNumber(p.poe_current)
  const linkUp = p.up ?? null
  return {
    idx: p.port_idx,
    poeCapable: p.port_poe === true || (p.poe_caps ?? 0) > 0,
    poeOn: p.poe_mode !== undefined ? p.poe_mode !== 'off' : p.poe_enable === true,
    linkUp,
    speedMbps: linkUp === true && p.speed !== undefined && p.speed > 0 ? p.speed : null,
    poePowerW: toNumber(p.poe_power),
    poeVoltageV: toNumber(p.poe_voltage),
    poeCurrentA: mA === null ? null : mA / 1000,
    clientMac: client === undefined ? null : client.mac.toLowerCase(),
    clientName: client === undefined ? null : clientLabel(client),
  }
}

function toSnapshot(
  device: ClassicDevice,
  wired: ReadonlyMap<string, ClassicClient>,
): UnifiInfraSnapshot {
  const state = mapState(device.state)
  const model = device.model ?? ''
  return {
    id: device._id,
    name: device.name ?? device.mac,
    mac: device.mac.toLowerCase(),
    model,
    kind: classifyUnifiInfra({ model, features: featuresOfType(device.type) }),
    cpuPercent: toNumber(device['system-stats']?.cpu),
    cpuTempC: cpuTemperature(device),
    clients: device.num_sta ?? 0,
    state,
    uptimeSec: device.uptime ?? null,
    ports: (device.port_table ?? []).map((p) => toPort(device, p, wired)),
    // `default` follows the site setting, which is on unless the operator turned it off.
    ledOn: device.led_override !== 'off',
    online: state === 'online',
    poeSwitchable: true,
  }
}

/**
 * The `port_overrides` list to PUT so ONE port's PoE mode changes. The controller REPLACES the
 * whole list on a PUT: a list carrying only the touched port would drop every other port's
 * override (its name, profile, PoE mode). So every entry is sent back as it was, with only this
 * port's `poe_mode` changed — or a new entry appended when the port had none. Pure.
 */
export function mergePoeOverride(
  overrides: readonly PortOverride[],
  portIdx: number,
  mode: UnifiPoeMode,
): PortOverride[] {
  const present = overrides.some((o) => o.port_idx === portIdx)
  if (!present) return [...overrides, { port_idx: portIdx, poe_mode: mode }]
  return overrides.map((o) => (o.port_idx === portIdx ? { ...o, poe_mode: mode } : o))
}

export interface UnifiClassicClientOptions {
  readonly session: UnifiSession
  readonly site: string
}

export class UnifiClassicClient implements UnifiControllerClient {
  readonly #session: UnifiSession
  readonly #siteRef: string
  #site: string | null = null
  #devices = new Map<string, ClassicDevice>()
  #infra = new Map<string, UnifiInfraSnapshot>()
  #clients = new Map<string, UnifiClientSnapshot>()

  constructor(options: UnifiClassicClientOptions) {
    this.#session = options.session
    this.#siteRef = options.site
  }

  /** Whether {@link connect} found the site. */
  get connected(): boolean {
    return this.#site !== null
  }

  async connect(): Promise<void> {
    await this.#session.login()
    const raw = await this.#session.api('GET', '/self/sites')
    const sites = z.array(siteSchema).parse(raw ?? [])
    const ref = this.#siteRef.toLowerCase()
    const match = sites.find((s) => s.name.toLowerCase() === ref || s.desc?.toLowerCase() === ref)
    if (match === undefined) {
      throw new UnifiSiteNotFoundError(
        this.#siteRef,
        sites.map((s) => s.name),
      )
    }
    this.#site = match.name
  }

  async disconnect(): Promise<void> {
    this.#site = null
    this.#devices = new Map()
    this.#infra = new Map()
    this.#clients = new Map()
    await this.#session.logout()
  }

  async listInfraDevices(): Promise<readonly UnifiInfraSnapshot[]> {
    const site = this.#requireSite()
    const devices = z
      .array(deviceSchema)
      .parse((await this.#session.api('GET', `/s/${site}/stat/device`)) ?? [])
    const wired = wiredClientIndex(await this.#stations(site))
    this.#devices = new Map(devices.map((d) => [d._id, d]))
    const snapshots = devices.map((d) => toSnapshot(d, wired))
    this.#infra = new Map(snapshots.map((s) => [s.id, s]))
    return snapshots
  }

  async listClients(): Promise<readonly UnifiClientSnapshot[]> {
    const site = this.#requireSite()
    // `stat/sta` lists only clients currently connected.
    const snapshots: UnifiClientSnapshot[] = (await this.#stations(site)).map((r) => ({
      mac: r.mac.toLowerCase(),
      hostname: r.name ?? r.hostname ?? '',
      ip: r.ip ?? null,
      connected: true,
      online: true,
    }))
    this.#clients = new Map(snapshots.map((s) => [s.mac, s]))
    return snapshots
  }

  getInfraDevice(id: string): UnifiInfraSnapshot | null {
    return this.#infra.get(id) ?? null
  }

  /** The classic `_id` of the device with this MAC in the last listing, or null. */
  idForMac(mac: string): string | null {
    const wanted = mac.toLowerCase()
    for (const d of this.#devices.values()) if (d.mac.toLowerCase() === wanted) return d._id
    return null
  }

  getClient(mac: string): UnifiClientSnapshot | null {
    return this.#clients.get(mac) ?? null
  }

  /**
   * Switch one port's PoE on (`auto`) or off. The device is read FRESH first so the PUT carries
   * the controller's current `port_overrides` (see {@link mergePoeOverride}), not a copy as old as
   * the last poll.
   */
  async setPortPoe(deviceId: string, portIdx: number, on: boolean): Promise<void> {
    const site = this.#requireSite()
    const known = this.#requireDevice(deviceId)
    const fresh = z
      .array(deviceSchema)
      .parse(
        (await this.#session.api(
          'GET',
          `/s/${site}/stat/device/${encodeURIComponent(known.mac)}`,
        )) ?? [],
      )
      .find((d) => d._id === deviceId)
    if (fresh === undefined) {
      throw new UnifiApiError(404, `unifi: device ${deviceId} is no longer on site "${site}"`)
    }
    const portOverrides = mergePoeOverride(fresh.port_overrides ?? [], portIdx, on ? 'auto' : 'off')
    await this.#session.api('PUT', `/s/${site}/rest/device/${encodeURIComponent(deviceId)}`, {
      port_overrides: portOverrides,
    })
    this.#devices.set(deviceId, { ...fresh, port_overrides: portOverrides })
  }

  async setLed(deviceId: string, on: boolean): Promise<void> {
    const site = this.#requireSite()
    this.#requireDevice(deviceId)
    await this.#session.api('PUT', `/s/${site}/rest/device/${encodeURIComponent(deviceId)}`, {
      led_override: on ? 'on' : 'off',
    })
  }

  async restartDevice(deviceId: string): Promise<void> {
    const site = this.#requireSite()
    const device = this.#requireDevice(deviceId)
    await this.#session.api('POST', `/s/${site}/cmd/devmgr`, {
      cmd: 'restart',
      mac: device.mac,
    })
  }

  async powerCyclePort(deviceId: string, portIdx: number): Promise<void> {
    const site = this.#requireSite()
    const device = this.#requireDevice(deviceId)
    await this.#session.api('POST', `/s/${site}/cmd/devmgr`, {
      cmd: 'power-cycle',
      mac: device.mac,
      port_idx: portIdx,
    })
  }

  degradedError(): Error | null {
    return null
  }

  async #stations(site: string): Promise<readonly ClassicClient[]> {
    return z
      .array(clientSchema)
      .parse((await this.#session.api('GET', `/s/${site}/stat/sta`)) ?? [])
  }

  #requireSite(): string {
    if (this.#site === null) throw new Error('unifi: client is not connected')
    return this.#site
  }

  #requireDevice(deviceId: string): ClassicDevice {
    const device = this.#devices.get(deviceId)
    if (device === undefined) {
      throw new UnifiApiError(404, `unifi: device ${deviceId} is not in the last listing`)
    }
    return device
  }
}
