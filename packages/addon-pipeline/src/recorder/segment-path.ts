export function segmentRelPath(
  deviceId: number,
  profile: string,
  startMs: number,
  durMs: number,
  bytes: number,
): string {
  if (profile.includes('/'))
    throw new Error(`segmentRelPath: profile must not contain '/': ${profile}`)
  const d = new Date(startMs)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  const mm = p2(d.getUTCMonth() + 1)
  const dd = p2(d.getUTCDate())
  const hh = p2(d.getUTCHours())
  return `${deviceId}/${profile}/${yyyy}/${mm}/${dd}/${hh}/${startMs}-${durMs}-${bytes}.m4s`
}

const SEG_RE = /^(\d+)\/([^/]+)\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/(\d+)-(\d+)-(\d+)\.m4s$/

/**
 * The profile names the recorder writes. Used ONLY to hand back a shared string
 * instead of a fresh one — never to reject a name.
 *
 * `SEG_RE`'s second group is a slice of the path, so V8 materialises a new
 * string for it on every parse. The whole fleet has three profile names and the
 * index holds one row per segment, so that is one redundant string per segment
 * held for the segment's whole life. Measured on the production shape (17
 * cameras x 2 profiles x 12 days of 10 s segments = 3.53 M rows): 798 MB
 * without this, 717 MB with it — 80.7 MB, 24 B/row, ~10% of the index.
 *
 * A name outside this set falls through to the parsed slice unchanged, so an
 * unrecognised profile is never renamed, never dropped, and costs exactly what
 * it costs today. That fall-through is the property the tests pin.
 */
const CANONICAL_PROFILES: readonly string[] = ['high', 'mid', 'low']

/** The shared instance of `profile` when it is one of {@link CANONICAL_PROFILES},
 *  otherwise `profile` itself. */
function canonicalProfile(profile: string): string {
  for (const known of CANONICAL_PROFILES) if (known === profile) return known
  return profile
}

export function parseSegmentPath(
  relPath: string,
): { deviceId: number; profile: string; startMs: number; durMs: number; bytes: number } | null {
  const m = SEG_RE.exec(relPath)
  if (!m) return null
  return {
    deviceId: Number(m[1]),
    profile: canonicalProfile(m[2]!),
    startMs: Number(m[3]),
    durMs: Number(m[4]),
    bytes: Number(m[5]),
  }
}
