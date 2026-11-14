import type { HmProgram } from 'nodehomematic'
import { describe, expect, it, vi } from 'vitest'
import {
  buildCcuProgramHandlers,
  ProgramRefusalError,
  parseLastRun,
} from '../ccu/ccu-programs-actions.js'
import { fakeDeps } from './ccu-fake.js'
import { hmDevice } from './hm-test-fixtures.js'

const KEY = '00315F298E5093'
const PROGRAM_NAME = 'CamStack: Pulsante bagno events'

function keyDevice() {
  return hmDevice({
    address: KEY,
    type: 'HmIP-BS2',
    name: 'Pulsante bagno',
    channels: [
      { address: `${KEY}:1`, index: 1, type: 'KEY_TRANSCEIVER', name: 'Sinistra' },
      { address: `${KEY}:2`, index: 2, type: 'KEY_TRANSCEIVER' },
    ],
  })
}

const CAMSTACK: HmProgram = {
  id: '42',
  name: PROGRAM_NAME,
  isActive: true,
  isInternal: false,
  lastExecuteTime: '2026-11-13 21:04:00',
}

const NIGHT: HmProgram = {
  id: '7',
  name: 'Night light',
  isActive: false,
  isInternal: false,
}

const EPOCH: HmProgram = {
  id: '1',
  name: 'Epoch',
  isActive: true,
  isInternal: true,
  lastExecuteTime: '0',
}

describe('parseLastRun', () => {
  it('drops a missing run and epoch 0', () => {
    expect(parseLastRun(undefined)).toBeNull()
    expect(parseLastRun('')).toBeNull()
    expect(parseLastRun('0')).toBeNull()
    expect(parseLastRun('1970-01-01T00:00:00.000Z')).toBeNull()
    expect(parseLastRun('2026-11-13 21:04:00')).toBe(Date.parse('2026-11-13T21:04:00'))
  })
})

describe('listCcuPrograms', () => {
  it('maps library programs to rows and resolves a condition channel to the CamStack device', async () => {
    const getKeyEventProgram = vi.fn(async (name: string) => {
      if (name !== PROGRAM_NAME) return null
      return { programId: '42', channelAddresses: [`${KEY}:1`] }
    })
    const { deps } = fakeDeps({
      devices: () => [keyDevice()],
      programs: () => [CAMSTACK, NIGHT, EPOCH],
      getKeyEventProgram,
    })
    const handlers = buildCcuProgramHandlers({
      ...deps,
      adoptedAddresses: async () => new Map([[KEY, 7]]),
      adoptedNames: async () => new Map([[KEY, 'Bagno Camerette']]),
    })
    const out = await handlers.listCcuPrograms({ integrationId: 'hm_1' })
    expect(getKeyEventProgram).toHaveBeenCalledTimes(1)
    expect(getKeyEventProgram).toHaveBeenCalledWith(PROGRAM_NAME)
    expect(out.programs).toEqual([
      {
        id: '42',
        name: PROGRAM_NAME,
        active: true,
        internal: false,
        lastRunMs: Date.parse('2026-11-13T21:04:00'),
        createdByCamstack: true,
        channels: [
          {
            address: `${KEY}:1`,
            channelName: 'Sinistra',
            deviceName: 'Bagno Camerette',
            deviceId: 7,
          },
        ],
      },
      {
        id: '7',
        name: 'Night light',
        active: false,
        internal: false,
        lastRunMs: null,
        createdByCamstack: false,
        channels: [],
      },
      {
        id: '1',
        name: 'Epoch',
        active: true,
        internal: true,
        lastRunMs: null,
        createdByCamstack: false,
        channels: [],
      },
    ])
    expect(out.keys.map((key) => key.address)).toEqual([`${KEY}:1`, `${KEY}:2`])
    expect(out.keys[0]?.deviceName).toBe('Bagno Camerette')
  })

  it('refuses when the CCU is not connected, and surfaces a read that fails', async () => {
    const missing = buildCcuProgramHandlers(fakeDeps(null).deps)
    await expect(missing.listCcuPrograms({ integrationId: 'hm_1' })).rejects.toBeInstanceOf(
      ProgramRefusalError,
    )
    await expect(missing.listCcuPrograms({ integrationId: 'hm_1' })).rejects.toMatchObject({
      reason: 'not-connected',
    })

    const { deps } = fakeDeps({
      devices: () => [],
      programs: () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(
      buildCcuProgramHandlers(deps).listCcuPrograms({ integrationId: 'hm_1' }),
    ).rejects.toThrow('ECONNREFUSED')
  })
})

describe('program writes', () => {
  it('runs, enables and deletes the program the id names, only once confirmed', async () => {
    const runProgram = vi.fn(async () => undefined)
    const setProgramActive = vi.fn(async () => undefined)
    const deleteProgram = vi.fn(async () => ({ removed: true }))
    const removeKeyEventProgram = vi.fn(async () => ({ removed: true }))
    const refreshHub = vi.fn(async () => undefined)
    const changed = vi.fn()
    const { deps, logger } = fakeDeps({
      devices: () => [keyDevice()],
      programs: () => [CAMSTACK],
      getKeyEventProgram: async () => ({ programId: '42', channelAddresses: [`${KEY}:1`] }),
      runProgram,
      setProgramActive,
      deleteProgram,
      removeKeyEventProgram,
      refreshHub,
    })
    const handlers = buildCcuProgramHandlers({
      ...deps,
      ccuChanged: changed,
      adoptedAddresses: async () => new Map([[KEY, 7]]),
      adoptedNames: async () => new Map([[KEY, 'Bagno Camerette']]),
    })
    const ref = { integrationId: 'hm_1', programId: '42' }

    await expect(handlers.runCcuProgram({ ...ref, confirmed: false })).rejects.toMatchObject({
      reason: 'not-confirmed',
    })
    expect(runProgram).not.toHaveBeenCalled()

    await expect(handlers.runCcuProgram({ ...ref, confirmed: true })).resolves.toEqual({ ok: true })
    expect(runProgram).toHaveBeenCalledWith('42')
    expect(logger.lines.some((line) => line.tags['deviceId'] === 7)).toBe(true)

    await expect(
      handlers.setCcuProgramActive({ ...ref, active: false, confirmed: true }),
    ).resolves.toEqual({ ok: true })
    expect(setProgramActive).toHaveBeenCalledWith('42', false)

    await expect(handlers.deleteCcuProgram({ ...ref, confirmed: true })).resolves.toEqual({
      ok: true,
    })
    expect(deleteProgram).toHaveBeenCalledWith('42')
    expect(removeKeyEventProgram).not.toHaveBeenCalled()
    expect(refreshHub).toHaveBeenCalled()
    expect(changed).toHaveBeenCalledWith('hm_1')
  })

  it('refuses an unknown id and an internal program before any write', async () => {
    const deleteProgram = vi.fn(async () => ({ removed: true }))
    const { deps } = fakeDeps({
      programs: () => [{ ...NIGHT, isInternal: true }],
      deleteProgram,
    })
    const handlers = buildCcuProgramHandlers(deps)
    await expect(
      handlers.deleteCcuProgram({ integrationId: 'hm_1', programId: 'missing', confirmed: true }),
    ).rejects.toMatchObject({ reason: 'unknown-program' })
    await expect(
      handlers.deleteCcuProgram({ integrationId: 'hm_1', programId: '7', confirmed: true }),
    ).rejects.toMatchObject({ reason: 'internal' })
    expect(deleteProgram).not.toHaveBeenCalled()
  })

  it('creates a key-event program for the device keys and refuses anything else', async () => {
    const ensureKeyEventProgram = vi.fn(async () => ({ programId: '55', created: true }))
    const refreshHub = vi.fn(async () => undefined)
    const { deps, logger } = fakeDeps({
      devices: () => [
        keyDevice(),
        hmDevice({ address: 'RF1', type: 'HM-RC-4', name: 'Old', channels: [] }),
      ],
      ensureKeyEventProgram,
      refreshHub,
    })
    const handlers = buildCcuProgramHandlers({
      ...deps,
      adoptedAddresses: async () => new Map([[KEY, 7]]),
    })
    const input = {
      integrationId: 'hm_1',
      deviceAddress: KEY,
      channelAddresses: [`${KEY}:1`, `${KEY}:1`],
      confirmed: true,
    }
    await expect(
      handlers.ensureCcuKeyEventProgram({ ...input, confirmed: false }),
    ).rejects.toMatchObject({ reason: 'not-confirmed' })
    expect(ensureKeyEventProgram).not.toHaveBeenCalled()

    await expect(handlers.ensureCcuKeyEventProgram(input)).resolves.toEqual({ ok: true })
    expect(ensureKeyEventProgram).toHaveBeenCalledWith({
      name: PROGRAM_NAME,
      channelAddresses: [`${KEY}:1`],
    })
    expect(logger.lines.some((line) => line.tags['deviceId'] === 7)).toBe(true)

    await expect(
      handlers.ensureCcuKeyEventProgram({ ...input, deviceAddress: 'RF1' }),
    ).rejects.toMatchObject({ reason: 'not-hmip-key' })
    await expect(
      handlers.ensureCcuKeyEventProgram({ ...input, channelAddresses: [`${KEY}:9`] }),
    ).rejects.toMatchObject({ reason: 'unknown-channel' })
    expect(ensureKeyEventProgram).toHaveBeenCalledTimes(1)
  })
})
