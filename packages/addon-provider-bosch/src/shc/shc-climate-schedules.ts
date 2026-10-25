export interface ShcHeatingProfile {
  readonly id: string
  readonly preset: string
}

export interface ShcHeatingScheduleView {
  readonly activeId: string | null
  readonly profiles: readonly ShcHeatingProfile[]
}

/** Heating profiles from `GET /climate/schedule/{id}/HEATING`. */
export function heatingProfilesFromSchedule(body: unknown): ShcHeatingScheduleView {
  if (body === null || typeof body !== 'object') return { activeId: null, profiles: [] }
  const root = body as Record<string, unknown>
  const activeId = typeof root['activeScheduleId'] === 'string' ? root['activeScheduleId'] : null
  const rows = Array.isArray(root['scheduleData']) ? root['scheduleData'] : []
  const seen = new Map<string, number>()
  const profiles: ShcHeatingProfile[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const id = item['id']
    if (typeof id !== 'string' || id.length === 0) continue
    const kind = scheduleKind(item['attributeExtensionMap'])
    const count = (seen.get(kind) ?? 0) + 1
    seen.set(kind, count)
    profiles.push({ id, preset: count === 1 ? kind : `${kind}-${count}` })
  }
  return { activeId, profiles }
}

export function climatePresetSelection(view: ShcHeatingScheduleView): {
  readonly preset: string
  readonly availablePresets: readonly string[]
} {
  const active = view.profiles.find((profile) => profile.id === view.activeId)
  return {
    preset: active?.preset ?? '',
    availablePresets: view.profiles.map((profile) => profile.preset),
  }
}

function scheduleKind(extension: unknown): string {
  if (extension === null || typeof extension !== 'object') return 'profile'
  const kind = (extension as Record<string, unknown>)['ScheduleType']
  if (typeof kind !== 'string' || kind.trim().length === 0) return 'profile'
  return kind.trim().toLowerCase()
}
