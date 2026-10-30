import {
  CoverDevice,
  type DeviceGateway,
  type DeviceState,
  type HubIdentity,
  type RademacherDeviceInfo,
} from '@apocaliss92/noderademacher'
import type { RademacherClient } from '../rademacher-integration-manager.js'

/** A scripted HomePilot transport: per-did state, optional failure switch. */
export class FakeHubGateway implements DeviceGateway {
  failing = false
  fetches = 0
  async fetchState(_did: string): Promise<DeviceState> {
    this.fetches += 1
    if (this.failing) throw new Error('hub unreachable')
    return { available: true, statuses: { Position: 0 }, readings: {}, raw: {} }
  }
  async sendCommand(): Promise<void> {}
}

export function coverInfo(did: string, name: string, model = 'RolloTron'): RademacherDeviceInfo {
  return {
    did,
    typeLoc: '2',
    category: 'cover',
    name,
    model,
    capabilities: { GOTO_POS_CMD: { name: 'GOTO_POS_CMD' } },
    raw: {},
  }
}

export function makeCover(gateway: DeviceGateway, did: string, name: string): CoverDevice {
  return new CoverDevice(coverInfo(did, name), gateway)
}

export const IDENTITY: HubIdentity = {
  host: '192.168.10.50',
  model: 'HomePilot',
  name: 'Casa',
  firmware: '5.5.1',
  uid: 'AABBCCDDEEFF',
  basePath: '',
  passwordProtected: true,
}

/** A client the manager can drive: connect behaviour is scripted, devices are real cover handles. */
export class FakeHubClient implements RademacherClient {
  connects = 0
  connectError: Error | null = null
  constructor(
    private readonly covers: readonly CoverDevice[],
    private readonly identity: HubIdentity | null = IDENTITY,
  ) {}
  async connect(): Promise<void> {
    this.connects += 1
    if (this.connectError !== null) throw this.connectError
  }
  async getDevices(): Promise<CoverDevice[]> {
    // The library seeds every handle with an initial state poll.
    await Promise.all(this.covers.map((c) => c.refresh()))
    return [...this.covers]
  }
  getIdentity(): Readonly<HubIdentity> | null {
    return this.identity
  }
}
