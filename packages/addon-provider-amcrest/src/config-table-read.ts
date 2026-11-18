import { isCgiHttpStatus } from './amcrest-cgi-client.js'

/**
 * Reading several Dahua `configManager` tables when a model may lack some.
 *
 * A multi-name `getConfig` is one request, and the firmware answers it as one:
 * a single table the model does not have (a Lite model with no `Lighting`)
 * turns the WHOLE request into HTTP 400, and every table that WAS there is
 * lost with it. So a 400 on the batch is not "the camera failed" — it is
 * "one of these names is unknown here". The reader then asks each name on its
 * own, keeps every table that answers, and names the ones the camera refused
 * with 400, so the caller can batch only the supported names next time.
 *
 * Only a 400 means "unsupported". A network error, a timeout or a 401 is a
 * failed read and propagates unchanged — folding it into "this camera has no
 * such table" would hide a camera that simply did not answer (D393).
 */

/** The two reads this module needs — `AmcrestCgiClient` satisfies it. */
export interface DahuaConfigReader {
  getConfig(name: string): Promise<Map<string, string>>
  getConfigs(names: readonly string[]): Promise<Map<string, string>>
}

export interface ConfigTablesRead {
  /** Every key of every table that answered, flat (keys carry their table prefix). */
  readonly table: ReadonlyMap<string, string>
  /** Every requested name the camera does not have: the ones already known
   *  plus the ones this read discovered. */
  readonly unsupported: readonly string[]
}

/**
 * Read `names`, skipping `knownUnsupported`. One batched request when every
 * remaining name is supported; on a batch 400, one request per name.
 */
export async function readConfigTables(
  reader: DahuaConfigReader,
  names: readonly string[],
  knownUnsupported: ReadonlySet<string>,
): Promise<ConfigTablesRead> {
  const wanted = names.filter((name) => !knownUnsupported.has(name))
  const alreadyUnsupported = names.filter((name) => knownUnsupported.has(name))
  if (wanted.length === 0) return { table: new Map(), unsupported: alreadyUnsupported }
  try {
    return {
      table: await reader.getConfigs(wanted),
      unsupported: alreadyUnsupported,
    }
  } catch (err: unknown) {
    if (!isCgiHttpStatus(err, 400)) throw err
    // A single name refused with 400 needs no second request to be named.
    if (wanted.length === 1) {
      return {
        table: new Map(),
        unsupported: [...alreadyUnsupported, ...wanted],
      }
    }
  }
  const merged = new Map<string, string>()
  const refused: string[] = []
  for (const name of wanted) {
    try {
      for (const [key, value] of await reader.getConfig(name)) merged.set(key, value)
    } catch (err: unknown) {
      if (!isCgiHttpStatus(err, 400)) throw err
      refused.push(name)
    }
  }
  return { table: merged, unsupported: [...alreadyUnsupported, ...refused] }
}
