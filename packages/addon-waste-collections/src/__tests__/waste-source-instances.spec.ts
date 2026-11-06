import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import catalogJson from '../catalog.json'
import { WasteFetchTimeoutError, WasteProviderRejectedError } from '../fetch-source.js'
import { listCatalogCountries } from '../waste-catalog.js'
import { isSecretArg, SECRET_ARG_KEYS } from '../waste-secrets.js'
import {
  COUNTRY_FIELD,
  serviceFieldKey,
  WASTE_TEST_TIMEOUT_MS,
  type WasteFetcher,
  WasteSourceInstances,
} from '../waste-source-instances.js'
import { wasteSourceEntryKind } from '../waste-source-record-kinds.js'
import { WasteSourceStore } from '../waste-source-store.js'

const SERVICE = 'recyclesmart_com--recyclesmart'
const COUNTRY = 'australia'

async function start(fetchImpl?: WasteFetcher, python = true) {
  const world = makeInMemoryRecords('waste-collections')
  await world.records.declare({ 'waste-source': wasteSourceEntryKind })
  const changes: string[] = []
  const calls: {
    timeoutMs: number | undefined
    args: Record<string, unknown>
  }[] = []
  const fetch: WasteFetcher = fetchImpl ?? (async () => [{ date: '2026-11-10', type: 'Paper' }])
  const instances = new WasteSourceInstances(world.records, {
    onChanged: async (id, change) => {
      changes.push(`${change}:${id}`)
    },
    fetchDeps: () => (python ? { pythonPath: 'py', scriptPath: 'fetch.py' } : null),
    fetch: async (deps, input) => {
      calls.push({ timeoutMs: deps.timeoutMs, args: { ...input.args } })
      return fetch(deps, input)
    },
  })
  const raw = world.records.kind(wasteSourceEntryKind)
  return { instances, raw, changes, calls }
}

const CREATE_VALUES = {
  [COUNTRY_FIELD]: COUNTRY,
  [serviceFieldKey(COUNTRY)]: SERVICE,
  email: 'me@example.com',
  password: 'hunter2',
}

describe('waste-source instances', () => {
  it('describes one testable kind of the calendar-source function cap', async () => {
    const { instances } = await start()
    const d = await instances.describe()
    expect(d.kinds).toEqual([
      expect.objectContaining({
        id: 'waste-source',
        functionCap: 'calendar-source',
      }),
    ])
    expect(d.canTest).toBe(true)
  })

  it("the create form shows a country's services only for that country", async () => {
    const { instances } = await start()
    const form = await instances.instanceFormSchema({ id: null })
    const fields = form.sections.flatMap((s) => s.fields)
    const country = fields.find((f) => f.key === COUNTRY_FIELD)
    expect(country?.type === 'select' && country.options.length).toBe(listCatalogCountries().length)
    const services = fields.find((f) => f.key === serviceFieldKey(COUNTRY))
    expect(services).toMatchObject({
      type: 'select',
      showWhen: { field: COUNTRY_FIELD, equals: COUNTRY },
    })
    expect(services?.type === 'select' && services.options.some((o) => o.value === SERVICE)).toBe(
      true,
    )
  })

  it('create keeps the credential in the keychain; list and edit never show it', async () => {
    const { instances, raw, changes } = await start()
    const { id } = await instances.createInstance({
      name: 'Home bins',
      values: CREATE_VALUES,
    })
    expect(id).toBe('home-bins')
    expect(changes).toEqual(['created:home-bins'])

    const stored = await raw.get(id)
    expect(stored?.data).toMatchObject({
      name: 'Home bins',
      module: 'recyclesmart_com',
      enabled: true,
    })
    expect(stored?.data.args.password).toBe(REDACTED_SECRET)
    expect((await raw.getResolved(id))?.data.args.password).toBe('hunter2')

    const [view] = await instances.listInstances()
    expect(view).toMatchObject({
      id,
      name: 'Home bins',
      enabled: true,
      configured: true,
      kind: 'waste-source',
    })
    expect(JSON.stringify(view)).not.toContain('hunter2')
    expect(view?.formValues).toMatchObject({
      email: 'me@example.com',
      serviceId: SERVICE,
    })
    expect(view?.formValues['password']).toMatchObject({
      $secret: expect.any(String),
    })

    const form = await instances.instanceFormSchema({ id })
    expect(form.sections.flatMap((s) => s.fields).map((f) => f.key)).toEqual(['email', 'password'])
  })

  it('update keeps a credential sent back redacted, replaces a new one, clears on request', async () => {
    const { instances, raw } = await start()
    const { id } = await instances.createInstance({
      name: 'Home',
      values: CREATE_VALUES,
    })
    await instances.updateInstance({
      id,
      values: { email: 'new@example.com', password: REDACTED_SECRET },
    })
    expect((await raw.getResolved(id))?.data.args).toMatchObject({
      email: 'new@example.com',
      password: 'hunter2',
    })
    await instances.updateInstance({ id, values: { password: 'rotated' } })
    expect((await raw.getResolved(id))?.data.args.password).toBe('rotated')
    await instances.updateInstance({
      id,
      name: 'Renamed',
      values: { password: { $secretClear: true } },
    })
    const after = await raw.getResolved(id)
    expect(after?.data.name).toBe('Renamed')
    expect(after?.data.args.password).toBeUndefined()
    expect(after?.data.args.email).toBe('new@example.com')
  })

  it('the switch and delete go through the record; an existing id is never overwritten', async () => {
    const { instances, raw, changes } = await start()
    const { id } = await instances.createInstance({
      name: 'Home',
      values: CREATE_VALUES,
    })
    await instances.toProvider().setInstanceEnabled({ id, enabled: false })
    expect((await instances.getInstance({ id }))?.enabled).toBe(false)
    expect((await raw.get(id))?.data.enabled).toBe(false)
    await expect(
      instances.createInstance({ id, name: 'Other', values: CREATE_VALUES }),
    ).rejects.toThrow()
    expect((await raw.get(id))?.data.name).toBe('Home')
    await instances.deleteInstance({ id })
    expect(await raw.get(id)).toBeNull()
    expect(changes).toEqual([`created:${id}`, `enabled:${id}`, `deleted:${id}`])
  })

  it('the switch flips the one field the calendar readers use, and never invents a source', async () => {
    const world = makeInMemoryRecords('waste-collections')
    await world.records.declare({ 'waste-source': wasteSourceEntryKind })
    const instances = new WasteSourceInstances(world.records, {
      onChanged: async () => {},
      fetchDeps: () => null,
    })
    const setEnabled = instances.toProvider().setInstanceEnabled
    const reader = WasteSourceStore.of(world.records)
    const { id } = await instances.createInstance({ name: 'Home', values: CREATE_VALUES })
    expect((await reader.readResolved(id))?.enabled).toBe(true)
    await setEnabled({ id, enabled: false })
    expect((await reader.readResolved(id))?.enabled).toBe(false)
    expect((await reader.listResolved()).map((s) => s.enabled)).toEqual([false])
    await setEnabled({ id, enabled: true })
    expect((await reader.readResolved(id))?.enabled).toBe(true)
    await expect(setEnabled({ id: 'ghost', enabled: false })).rejects.toThrow(/not found/)
    expect(await reader.listIds()).toEqual([id])
  })

  it('create refuses without a service', async () => {
    const { instances } = await start()
    await expect(instances.createInstance({ name: 'x', values: {} })).rejects.toThrow(
      'pick a country',
    )
  })
})

describe('waste-source testInstance', () => {
  it('a fetch with collections is validated, within the probe timeout, with the saved credential', async () => {
    const { instances, calls } = await start()
    const { id } = await instances.createInstance({
      name: 'Home',
      values: CREATE_VALUES,
    })
    const result = await instances.testInstance({
      id,
      values: { password: REDACTED_SECRET },
    })
    expect(result).toMatchObject({
      success: true,
      status: 'validated',
      detail: '1 collections found',
    })
    expect(calls).toEqual([
      {
        timeoutMs: WASTE_TEST_TIMEOUT_MS,
        args: { email: 'me@example.com', password: 'hunter2' },
      },
    ])
  })

  it('probes an unsaved draft from its form values', async () => {
    const { instances, calls } = await start()
    const result = await instances.testInstance({
      id: null,
      values: CREATE_VALUES,
    })
    expect(result.status).toBe('validated')
    expect(calls[0]?.args).toMatchObject({ password: 'hunter2' })
  })

  it('a provider refusal is rejected and its text never carries the credential', async () => {
    const { instances } = await start(async (_deps, input) => {
      throw new WasteProviderRejectedError(`login failed for ${String(input.args['password'])}`)
    })
    const { id } = await instances.createInstance({
      name: 'Home',
      values: CREATE_VALUES,
    })
    const result = await instances.testInstance({ id, values: {} })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(JSON.stringify(result)).not.toContain('hunter2')
    expect(result.error).toContain('login failed for ***')
  })

  it('a timeout, a crash, an empty answer and a missing Python are inconclusive, never a verdict', async () => {
    const timeout = await start(async () => {
      throw new WasteFetchTimeoutError(1, 'x')
    })
    expect(
      (
        await timeout.instances.testInstance({
          id: null,
          values: CREATE_VALUES,
        })
      ).status,
    ).toBe('inconclusive')
    const crash = await start(async () => {
      throw new Error('spawn ENOENT')
    })
    expect((await crash.instances.testInstance({ id: null, values: CREATE_VALUES })).status).toBe(
      'inconclusive',
    )
    const empty = await start(async () => [])
    expect(await empty.instances.testInstance({ id: null, values: CREATE_VALUES })).toMatchObject({
      success: false,
      status: 'inconclusive',
    })
    const noPython = await start(undefined, false)
    expect(
      await noPython.instances.testInstance({
        id: null,
        values: CREATE_VALUES,
      }),
    ).toMatchObject({
      success: false,
      status: 'inconclusive',
    })
    expect(noPython.calls).toEqual([])
  })
})

describe('waste-source testInstance without its required arguments', () => {
  const REQUIRED_SERVICE = 'app_my_local_services_au--adelaide-hills-council'

  it('answers inconclusive with a configure-first reason and never probes', async () => {
    const { instances, calls } = await start()
    const result = await instances.testInstance({
      id: null,
      values: {
        [COUNTRY_FIELD]: COUNTRY,
        [serviceFieldKey(COUNTRY)]: REQUIRED_SERVICE,
      },
    })
    expect(result.status).toBe('inconclusive')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^Configure the source first/)
    expect(calls).toEqual([])
  })

  it('probes once the required argument is there', async () => {
    const { instances, calls } = await start()
    const result = await instances.testInstance({
      id: null,
      values: {
        [COUNTRY_FIELD]: COUNTRY,
        [serviceFieldKey(COUNTRY)]: REQUIRED_SERVICE,
        lat: '-34.9',
      },
    })
    expect(result.status).toBe('validated')
    expect(calls).toHaveLength(1)
  })
})

describe('waste credentials are named in the kind', () => {
  it('every catalog credential argument is one of the names the kind keeps in the keychain', () => {
    const keys = new Set<string>()
    for (const service of catalogJson.services) for (const f of service.fields) keys.add(f.key)
    const unnamed = [...keys].filter((k) => isSecretArg(k) && !SECRET_ARG_KEYS.includes(k))
    expect(unnamed).toEqual([])
  })
})
