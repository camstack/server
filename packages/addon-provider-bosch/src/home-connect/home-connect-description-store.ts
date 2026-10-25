import {
  entityIndexFromDescription,
  programsFromDescription,
  type HomeConnectAccess,
  type HomeConnectEntityDef,
  type HomeConnectEntityKind,
  type HomeConnectProgramDef,
} from './home-connect-device-description.js'

/** Description state: `missing` = no entity map, values cannot be decoded. */
export type HomeConnectDescriptionState = 'complete' | 'missing'

/** An entity with its kind resolved and the live `/ro/descriptionChange` overlay applied. */
export interface HomeConnectEntityView extends HomeConnectEntityDef {
  readonly kind: HomeConnectEntityKind
}

/** One row of `/ro/descriptionChange` or `/ro/allDescriptionChanges`: constraint changes by uid. */
interface DescriptionOverlay {
  readonly available?: boolean
  readonly access?: HomeConnectAccess
  readonly min?: number
  readonly max?: number
  readonly stepSize?: number
  readonly defaultValue?: unknown
}

const ACCESS: readonly HomeConnectAccess[] = [
  'none',
  'read',
  'readWrite',
  'writeOnly',
  'readStatic',
]

/** Kind of a legacy description entity (stored before kinds were recorded), from its feature name. */
export function kindFromFeatureName(name: string): HomeConnectEntityKind {
  if (name.endsWith('Root.ActiveProgram')) return 'activeProgram'
  if (name.endsWith('Root.SelectedProgram')) return 'selectedProgram'
  if (name.includes('.Setting.')) return 'setting'
  if (name.includes('.Option.')) return 'option'
  if (name.includes('.Event.')) return 'event'
  if (name.includes('.Command.')) return 'command'
  if (name.includes('.Program.')) return 'program'
  return 'status'
}

function overlayFromRow(row: Readonly<Record<string, unknown>>): DescriptionOverlay {
  const access = ACCESS.find((a) => a === row['access'])
  const num = (key: string): number | undefined => {
    const v = row[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const min = num('min')
  const max = num('max')
  const stepSize = num('stepSize')
  return {
    ...(typeof row['available'] === 'boolean' ? { available: row['available'] } : {}),
    ...(access !== undefined ? { access } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(stepSize !== undefined ? { stepSize } : {}),
    ...(row['default'] !== undefined ? { defaultValue: row['default'] } : {}),
  }
}

/**
 * The live description of ONE appliance: the stored IDDF plus whatever the
 * appliance reported since (`/ro/descriptionChange`). The session decodes with it,
 * the devices read constraints from it; neither keeps a second copy.
 */
export class HomeConnectDescriptionStore {
  #base: ReadonlyMap<number, HomeConnectEntityDef>
  #programs: readonly HomeConnectProgramDef[]
  readonly #overlay = new Map<number, DescriptionOverlay>()
  readonly #listeners = new Set<() => void>()
  #views: ReadonlyMap<number, HomeConnectEntityView> | null = null

  constructor(initial: string | Record<string, unknown> | null | undefined) {
    this.#base = entityIndexFromDescription(initial)
    this.#programs = programsFromDescription(initial)
  }

  get state(): HomeConnectDescriptionState {
    return this.#base.size > 0 ? 'complete' : 'missing'
  }

  get size(): number {
    return this.#base.size
  }

  /** Swap in a freshly fetched description (the live overlay is dropped: it described the old one). */
  replace(next: string | Record<string, unknown> | null | undefined): void {
    this.#base = entityIndexFromDescription(next)
    this.#programs = programsFromDescription(next)
    this.#overlay.clear()
    this.#views = null
    this.#notify()
  }

  /** Apply description-change rows; returns the feature names whose constraints moved. */
  applyChanges(rows: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
    const touched: string[] = []
    for (const row of rows) {
      const uid = row['uid']
      if (typeof uid !== 'number') continue
      const base = this.#base.get(uid)
      if (base === undefined) continue
      const next = overlayFromRow(row)
      if (Object.keys(next).length === 0) continue
      this.#overlay.set(uid, { ...this.#overlay.get(uid), ...next })
      touched.push(base.name)
    }
    if (touched.length > 0) {
      this.#views = null
      this.#notify()
    }
    return touched
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(): void {
    for (const fn of this.#listeners) fn()
  }

  #resolved(): ReadonlyMap<number, HomeConnectEntityView> {
    if (this.#views !== null) return this.#views
    const out = new Map<number, HomeConnectEntityView>()
    for (const [uid, def] of this.#base) {
      const overlay = this.#overlay.get(uid)
      out.set(uid, { ...def, ...overlay, kind: def.kind ?? kindFromFeatureName(def.name) })
    }
    this.#views = out
    return out
  }

  /** The decode / encode index: uid → entity with the overlay applied. */
  index(): ReadonlyMap<number, HomeConnectEntityView> {
    return this.#resolved()
  }

  entity(uid: number): HomeConnectEntityView | undefined {
    return this.#resolved().get(uid)
  }

  entityByName(name: string): HomeConnectEntityView | undefined {
    for (const view of this.#resolved().values()) if (view.name === name) return view
    return undefined
  }

  entityOfKind(kind: HomeConnectEntityKind): HomeConnectEntityView | undefined {
    for (const view of this.#resolved().values()) if (view.kind === kind) return view
    return undefined
  }

  entities(): readonly HomeConnectEntityView[] {
    return [...this.#resolved().values()]
  }

  programs(): readonly HomeConnectProgramDef[] {
    return this.#programs
  }
}
