/**
 * The mirrored device directory the system-event intake reads.
 *
 * It answers two questions with NO I/O, because the intake runs on the event
 * path and D49 is explicit that a one-shot event never gates on a fallible
 * read: "is this id a camera" and "what is it called".
 *
 * The failure policy is the OPPOSITE of `NcDeviceStateCache`'s on purpose, and
 * the reason is worth stating: the state cache gates whether a rule may fire,
 * so a stale entry ARMS something the operator did not ask for, and it ages
 * out. This directory only decides how an event is WORDED and whether it is a
 * camera at all — a stale name is a cosmetic error, while an emptied directory
 * silences every camera-offline notification on the hub. So a failed refresh
 * keeps the previous snapshot indefinitely, and says so.
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { type NcDeviceIdentity, NcDeviceDirectory } from '../device-directory.js'

function camera(deviceId: number, name: string): NcDeviceIdentity {
  return { deviceId, type: DeviceType.Camera, name, isCamera: true }
}

function plug(deviceId: number, name: string): NcDeviceIdentity {
  return { deviceId, type: DeviceType.Switch, name, isCamera: false }
}

describe('NcDeviceDirectory', () => {
  it('reads nothing before the first refresh — a cold mirror knows no cameras', () => {
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => [camera(102, 'Front door')],
    })
    expect(directory.get(102)).toBeUndefined()
  })

  it('answers identity and type after a refresh', async () => {
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => [camera(102, 'Front door'), plug(2018, 'Presa')],
    })
    await directory.refresh()
    expect(directory.get(102)).toEqual(camera(102, 'Front door'))
    expect(directory.get(2018)?.isCamera).toBe(false)
    expect(directory.get(9_999)).toBeUndefined()
  })

  it('drops a device that disappeared from the last successful refresh', async () => {
    let devices: readonly NcDeviceIdentity[] = [camera(102, 'Front door'), plug(2018, 'Presa')]
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => devices,
    })
    await directory.refresh()
    devices = [camera(102, 'Front door')]
    await directory.refresh()
    expect(directory.get(2018)).toBeUndefined()
  })

  it('KEEPS the previous snapshot when a refresh fails, and never throws', async () => {
    let fail = false
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    const directory = new NcDeviceDirectory({
      logger,
      listDevices: async () => {
        if (fail) throw new Error('device-manager unreachable')
        return [camera(102, 'Front door')]
      },
    })
    await directory.refresh()
    fail = true
    await expect(directory.refresh()).resolves.toBe('failed')
    expect(directory.get(102)?.name).toBe('Front door')
    expect(warn).toHaveBeenCalled()
  })

  it('hands out a bound lookup the intake can hold', async () => {
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => [camera(102, 'Front door')],
    })
    const lookup = directory.lookup()
    expect(lookup(102)).toBeUndefined()
    await directory.refresh()
    expect(lookup(102)?.name).toBe('Front door')
  })
})

/**
 * The ANSWER record the deleted-device reconcile reads. A device may be pruned
 * from the notification rules only when it is missing from TWO consecutive
 * refreshes that actually answered — a failed read and an EMPTY list (a hub
 * restart window, a transport hiccup) are not answers, and one answer is not
 * two (a migration swap parks an id on a temp id for a moment).
 */
describe('NcDeviceDirectory — answered refreshes', () => {
  it('counts only non-empty successful refreshes, and remembers the previous answer', async () => {
    let next: readonly NcDeviceIdentity[] | Error = [camera(101, 'a'), camera(102, 'b')]
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => {
        if (next instanceof Error) throw next
        return next
      },
    })
    expect(await directory.refresh()).toBe('answered')
    expect(directory.answeredGeneration()).toBe(1)
    next = [camera(101, 'a')]
    expect(await directory.refresh()).toBe('answered')
    // Missing from ONE answer only — not yet.
    expect(directory.absentFromLastTwoAnswers(102)).toBe(false)
    next = new Error('transport down')
    expect(await directory.refresh()).toBe('failed')
    next = []
    expect(await directory.refresh()).toBe('empty')
    expect(directory.answeredGeneration()).toBe(2)
    expect(directory.absentFromLastTwoAnswers(102)).toBe(false)
    next = [camera(101, 'a')]
    expect(await directory.refresh()).toBe('answered')
    expect(directory.absentFromLastTwoAnswers(102)).toBe(true)
    expect(directory.absentFromLastTwoAnswers(101)).toBe(false)
  })

  it('a cold directory, or one answer, never calls an id absent', async () => {
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => [camera(101, 'a')],
    })
    expect(directory.absentFromLastTwoAnswers(102)).toBe(false)
    await directory.refresh()
    expect(directory.absentFromLastTwoAnswers(102)).toBe(false)
  })
})
