/**
 * A device whose power comes from a linked smart switch. `/devices/941` has one
 * (`Front door plug`, off time 20 s), `/devices/942` has none. Load BEFORE the
 * area it borrows its devices from (`--fixtures power-source,lock-door,helpers`).
 */
import { defineFixtures } from './_define'

const LINKED = {
  linked: true,
  switchDeviceId: 960,
  switchName: 'Front door plug',
  switchOn: true,
  switchOnline: true,
  restartInProgress: false,
  offSeconds: 20,
}

const UNLINKED = {
  linked: false,
  switchDeviceId: null,
  switchName: null,
  switchOn: null,
  switchOnline: null,
  restartInProgress: false,
  offSeconds: 0,
}

export default defineFixtures({
  area: 'power-source',
  description: 'Device page kebab with a linked power-source switch (941) and without (942)',
  handlers: {
    'powerSource.getStatus': (i: { deviceId?: number }) => (i.deviceId === 941 ? LINKED : UNLINKED),
    'powerSource.powerOn': () => ({ accepted: true }),
    'powerSource.powerOff': () => ({ accepted: true }),
    'powerSource.forceRestart': () => ({ accepted: true }),
  },
})
