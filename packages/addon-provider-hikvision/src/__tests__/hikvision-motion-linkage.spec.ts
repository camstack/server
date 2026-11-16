import { describe, expect, it } from 'vitest'
import { patchMotionTriggerLinkageXml } from '../hikvision-motion-linkage.js'

const EMAIL =
  '<EventTriggerNotification><id>email</id><notificationMethod>email</notificationMethod><notificationRecurrence>beginning</notificationRecurrence></EventTriggerNotification>'
const BEEP =
  '<EventTriggerNotification><id>beep</id><notificationMethod>beep</notificationMethod></EventTriggerNotification>'
const RECORD =
  '<EventTriggerNotification><id>record-1</id><notificationMethod>record</notificationMethod></EventTriggerNotification>'
const IO =
  '<EventTriggerNotification><id>IO-1</id><notificationMethod>IO</notificationMethod></EventTriggerNotification>'

function vmd(...blocks: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><EventTrigger version="2.0"><id>VMD-1</id>' +
    '<eventType>VMD</eventType><videoInputChannelID>1</videoInputChannelID>' +
    `<EventTriggerNotificationList>${blocks.join('')}</EventTriggerNotificationList></EventTrigger>`
  )
}

function listBlocks(xml: string): string[] {
  return xml.match(/<EventTriggerNotification>[\s\S]*?<\/EventTriggerNotification>/g) ?? []
}

describe('patchMotionTriggerLinkageXml', () => {
  it('turns beep off and keeps email, record and IO byte for byte', () => {
    const out = patchMotionTriggerLinkageXml(vmd(EMAIL, BEEP, RECORD, IO), { beep: false })
    expect(out).toBe(vmd(EMAIL, RECORD, IO))
  })

  it('turns beep on, appending it and leaving the others untouched', () => {
    const out = patchMotionTriggerLinkageXml(vmd(EMAIL, RECORD), { beep: true })
    expect(out).toBe(vmd(EMAIL, RECORD, BEEP))
    expect(out.match(/<EventTriggerNotificationList>/g)).toHaveLength(1)
    expect(out.match(/<\/EventTriggerNotificationList>/g)).toHaveLength(1)
  })

  it('keeps the camera-chosen id of a method that stays enabled', () => {
    const custom =
      '<EventTriggerNotification><id>beep-9</id><notificationMethod>beep</notificationMethod></EventTriggerNotification>'
    expect(patchMotionTriggerLinkageXml(vmd(EMAIL, custom), { beep: true })).toBe(
      vmd(EMAIL, custom),
    )
  })

  it('stays well formed when the sibling before the list is an email block', () => {
    const out = patchMotionTriggerLinkageXml(vmd(EMAIL, BEEP), { beep: false })
    expect(listBlocks(out)).toEqual([EMAIL])
    expect(out.match(/<EventTriggerNotification>/g)).toHaveLength(1)
    expect(out.match(/<\/EventTriggerNotification>/g)).toHaveLength(1)
  })

  it('creates the list when the document has none', () => {
    const bare = '<EventTrigger><id>VMD-1</id></EventTrigger>'
    expect(patchMotionTriggerLinkageXml(bare, { beep: true })).toBe(
      `<EventTrigger><id>VMD-1</id><EventTriggerNotificationList>${BEEP}</EventTriggerNotificationList></EventTrigger>`,
    )
  })
})
