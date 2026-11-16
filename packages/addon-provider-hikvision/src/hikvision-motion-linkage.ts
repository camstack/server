/**
 * Splice the managed notification methods of a VMD trigger document.
 *
 * The camera's own document is edited, never rebuilt: every
 * `<EventTriggerNotification>` block we do not change (email, record, the ids
 * the camera chose) stays byte for byte. Blocks are matched one by one — the
 * opening tag must be `<EventTriggerNotification>` itself, not
 * `<EventTriggerNotificationList>`, whose prefix a looser pattern also matches
 * and which then swallows the sibling before it.
 */
export interface MotionLinkagePatch {
  readonly beep?: boolean
  readonly whiteLight?: boolean
  readonly ioOutput?: boolean
  readonly center?: boolean
}

const MANAGED: ReadonlyArray<{ readonly key: keyof MotionLinkagePatch; readonly method: string }> =
  [
    { key: 'beep', method: 'beep' },
    { key: 'whiteLight', method: 'whiteLight' },
    { key: 'ioOutput', method: 'IO' },
    { key: 'center', method: 'center' },
  ]

const NOTIFICATION_BLOCK =
  /<EventTriggerNotification(?:\s[^>]*)?>[\s\S]*?<\/EventTriggerNotification>/gi

function methodOf(block: string): string | null {
  const found = /<notificationMethod>\s*([^<]*?)\s*<\/notificationMethod>/i.exec(block)
  return found ? found[1]!.toLowerCase() : null
}

export function patchMotionTriggerLinkageXml(xml: string, patch: MotionLinkagePatch): string {
  const present = new Set<string>()
  let result = xml.replace(NOTIFICATION_BLOCK, (block) => {
    const method = methodOf(block)
    const managed = MANAGED.find((m) => m.method.toLowerCase() === method)
    if (!managed) return block
    present.add(managed.method)
    return patch[managed.key] === false ? '' : block
  })

  const additions = MANAGED.filter((m) => patch[m.key] === true && !present.has(m.method))
    .map(
      (m) =>
        `<EventTriggerNotification><id>${m.method}</id><notificationMethod>${m.method}</notificationMethod></EventTriggerNotification>`,
    )
    .join('')
  if (additions === '') return result

  if (/<\/EventTriggerNotificationList>/i.test(result)) {
    result = result.replace(/<\/EventTriggerNotificationList>/i, `${additions}$&`)
  } else {
    result = result.replace(
      /<\/EventTrigger>/i,
      `<EventTriggerNotificationList>${additions}</EventTriggerNotificationList>$&`,
    )
  }
  return result
}
