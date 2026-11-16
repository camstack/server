/** Snapshot builders for the UniFi specs: every field present, the case under test overridden. */
import type { UnifiInfraPort, UnifiInfraSnapshot } from '../unifi-client-contract.js'

/** One port; a PoE-capable port with PoE on unless overridden. */
export function port(over: Partial<UnifiInfraPort> & Pick<UnifiInfraPort, 'idx'>): UnifiInfraPort {
  const base: UnifiInfraPort = {
    idx: over.idx,
    poeOn: true,
    poeCapable: true,
    linkUp: null,
    speedMbps: null,
    poePowerW: null,
    poeVoltageV: null,
    poeCurrentA: null,
    clientMac: null,
    clientName: null,
  }
  return { ...base, ...over }
}

/** One infra device; an online `other` without ports unless overridden. */
export function infraSnapshot(
  over: Partial<UnifiInfraSnapshot> & Pick<UnifiInfraSnapshot, 'id'>,
): UnifiInfraSnapshot {
  const base: UnifiInfraSnapshot = {
    id: over.id,
    name: over.id,
    mac: null,
    model: '',
    kind: 'other',
    cpuPercent: null,
    cpuTempC: null,
    clients: 0,
    state: 'online',
    uptimeSec: null,
    ports: [],
    ledOn: false,
    online: true,
    poeSwitchable: false,
  }
  return { ...base, ...over }
}
