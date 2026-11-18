/**
 * A Dahua Lite model (IPC-HDBW1431E-S4) has no `Lighting` table and no card
 * slot. It answers HTTP 400 for a multi-name `getConfig` that names a table it
 * does not have — losing every other table in the same request — and HTTP 400
 * for the storage query. These specs run the REAL CGI client against a local
 * HTTP server that answers like that camera.
 */
import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { AmcrestCgiClient } from '../amcrest-cgi-client.js'
import { availabilityFromStorage } from '../clips/clip-availability.js'
import { readConfigTables } from '../config-table-read.js'
import {
  AMCREST_EXTRAS_CONFIG_NAMES,
  buildExtrasSections,
  parseExtrasSnapshot,
} from '../extra-settings.js'
import { readOnboardStorage } from '../onboard-storage-read.js'

const TABLES: Readonly<Record<string, string>> = {
  LightGlobal: 'table.LightGlobal[0].Enable=true\r\n',
  NTP: 'table.NTP.Enable=true\r\ntable.NTP.Address=pool.ntp.org\r\ntable.NTP.Port=123\r\n',
  AutoMaintain: 'table.AutoMaintain.AutoRebootEnable=false\r\n',
}

interface FakeCamera {
  readonly client: AmcrestCgiClient
  /** Every request path the camera received, in order. */
  readonly requests: string[]
  readonly server: Server
}

/** A camera that has every table in {@link TABLES}, nothing else, and
 *  answers `storageStatus` for the storage query. */
async function fakeLiteCamera(storageStatus = 400): Promise<FakeCamera> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://camera')
    requests.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/cgi-bin/storageDevice.cgi') {
      res.statusCode = storageStatus
      res.end(storageStatus === 200 ? '' : 'Bad Request!')
      return
    }
    const names = url.searchParams.getAll('name')
    if (names.some((name) => TABLES[name] === undefined)) {
      res.statusCode = 400
      res.end('Bad Request!')
      return
    }
    res.end(names.map((name) => TABLES[name]).join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP port')
  const port = address.port
  const client = new AmcrestCgiClient({
    host: '127.0.0.1',
    port,
    https: false,
    username: 'admin',
    password: 'x',
  })
  return { client, requests, server }
}

let open: Server | null = null
afterEach(async () => {
  const server = open
  open = null
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('extras tables on a model without Lighting', () => {
  it('keeps the three tables that answer when the batch is refused with 400', async () => {
    const camera = await fakeLiteCamera()
    open = camera.server
    const read = await readConfigTables(camera.client, AMCREST_EXTRAS_CONFIG_NAMES, new Set())
    expect(read.unsupported).toEqual(['Lighting'])
    const snap = parseExtrasSnapshot(read.table, 1, read.unsupported)
    expect(snap.statusLedEnabled).toBe(true)
    expect(snap.ntpEnabled).toBe(true)
    expect(snap.ntpServer).toBe('pool.ntp.org')
    expect(snap.autoRebootEnabled).toBe(false)
    expect(snap.irLightMode).toBeUndefined()
  })

  it('batches only the supported names once the unsupported one is known', async () => {
    const camera = await fakeLiteCamera()
    open = camera.server
    const first = await readConfigTables(camera.client, AMCREST_EXTRAS_CONFIG_NAMES, new Set())
    camera.requests.length = 0
    const second = await readConfigTables(
      camera.client,
      AMCREST_EXTRAS_CONFIG_NAMES,
      new Set(first.unsupported),
    )
    expect(camera.requests).toEqual([
      '/cgi-bin/configManager.cgi?action=getConfig&name=LightGlobal&name=NTP&name=AutoMaintain',
    ])
    expect(second.unsupported).toEqual(['Lighting'])
    expect(second.table.get('NTP.Port')).toBe('123')
  })

  it('a failed read is not "unsupported": a network error propagates', async () => {
    const camera = await fakeLiteCamera()
    await new Promise<void>((resolve) => camera.server.close(() => resolve()))
    await expect(
      readConfigTables(camera.client, AMCREST_EXTRAS_CONFIG_NAMES, new Set()),
    ).rejects.toThrow()
  })

  it('the form leaves out the fields of the missing table, keeps the rest', () => {
    const sections = buildExtrasSections({
      fetchedAt: 1,
      statusLedEnabled: true,
      unsupportedTables: ['Lighting'],
    })
    const keys = sections.flatMap((section) =>
      section.fields.map((field) => ('key' in field ? field.key : '')),
    )
    expect(keys).not.toContain('irLightMode')
    expect(keys).not.toContain('irLightBrightness')
    expect(keys).toContain('statusLedEnabled')
    expect(keys).toContain('ntpServer')
    expect(keys).toContain('autoRebootEnabled')
  })

  it('a section whose every table is missing is dropped', () => {
    const sections = buildExtrasSections({
      fetchedAt: 1,
      unsupportedTables: ['Lighting', 'LightGlobal'],
    })
    expect(sections.map((section) => section.id)).toEqual(['time-ntp', 'auto-reboot'])
  })
})

describe('storage on a model with no card slot', () => {
  it('HTTP 400 on the storage query is no-storage, not unreachable', async () => {
    const camera = await fakeLiteCamera(400)
    open = camera.server
    const storage = await readOnboardStorage(() => camera.client.getStorageDeviceAllInfo())
    expect(storage.kind).toBe('absent')
    expect(availabilityFromStorage(storage)?.state).toBe('no-storage')
  })

  it('a 500 stays unreachable — a failed read is never "no card" (D393)', async () => {
    const camera = await fakeLiteCamera(500)
    open = camera.server
    const storage = await readOnboardStorage(() => camera.client.getStorageDeviceAllInfo())
    expect(availabilityFromStorage(storage)?.state).toBe('unreachable')
  })

  it('a network failure stays unreachable', async () => {
    const camera = await fakeLiteCamera(400)
    await new Promise<void>((resolve) => camera.server.close(() => resolve()))
    const storage = await readOnboardStorage(() => camera.client.getStorageDeviceAllInfo())
    expect(availabilityFromStorage(storage)?.state).toBe('unreachable')
  })

  it('an empty storage table is no-storage', async () => {
    const camera = await fakeLiteCamera(200)
    open = camera.server
    const storage = await readOnboardStorage(() => camera.client.getStorageDeviceAllInfo())
    expect(availabilityFromStorage(storage)?.state).toBe('no-storage')
  })
})
