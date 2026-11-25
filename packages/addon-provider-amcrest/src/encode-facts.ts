/**
 * What the camera's `Encode` config says about ONE stream, kept as read —
 * never defaulted. A fact the camera did not report is `null` and is named in
 * `missing` with the key that was absent, so a catalog line can say what it
 * could not learn (planning#727).
 */
export interface AmcrestEncodeFacts {
  readonly codecRaw: string | null
  readonly profile: string | null
  /** Dahua's Encode table carries no level key; reported absent, never guessed. */
  readonly level: string | null
  readonly width: number | null
  readonly height: number | null
  readonly fps: number | null
  /** GOP / keyframe interval, in frames. */
  readonly gop: number | null
  readonly bitrateKbps: number | null
  readonly missing: readonly string[]
}

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/** Read one stream's facts from the flattened Encode table (`prefix` = `MainFormat[0]`). */
export function readEncodeFacts(
  table: ReadonlyMap<string, string>,
  prefix: string,
): AmcrestEncodeFacts {
  const key = (name: string): string => `${prefix}.Video.${name}`
  const facts = {
    codecRaw: table.get(key('Compression')) ?? null,
    profile: table.get(key('Profile')) ?? null,
    level: table.get(key('Level')) ?? null,
    width: intOrNull(table.get(key('Width'))),
    height: intOrNull(table.get(key('Height'))),
    fps: intOrNull(table.get(key('FPS'))),
    gop: intOrNull(table.get(key('GOP'))),
    bitrateKbps: intOrNull(table.get(key('BitRate'))),
  }
  const sourceKeys: Readonly<Record<keyof typeof facts, string>> = {
    codecRaw: 'Compression',
    profile: 'Profile',
    level: 'Level',
    width: 'Width',
    height: 'Height',
    fps: 'FPS',
    gop: 'GOP',
    bitrateKbps: 'BitRate',
  }
  const missing = (Object.keys(facts) as Array<keyof typeof facts>)
    .filter((name) => facts[name] === null)
    .map((name) => `${name}: ${key(sourceKeys[name])} absent or unparsable in the Encode table`)
  return { ...facts, missing }
}
