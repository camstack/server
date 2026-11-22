/**
 * The pure half of a whole-capability link row (D1076): the stored `capLink`
 * feature of one link, set or cleared in the device's customization. The link
 * is ONE feature `{ cap, linkId, source }`; nothing is written per field.
 */
import {
  type CapLinkView,
  type Composition,
  type CompositionCapLinkFeature,
  type CompositionSourceRef,
  type CustomizeCapLink,
} from '@camstack/types'
import type { CapLinkCellState } from '@camstack/ui-library'

export interface OfferedCapLink {
  readonly cap: string
  readonly link: CustomizeCapLink
}

/** The stored feature of this link, if any. */
export function storedCapLink(
  current: Composition | null,
  cap: string,
  linkId: string,
): CompositionCapLinkFeature | null {
  for (const feature of current?.features ?? []) {
    if (feature.kind === 'capLink' && feature.cap === cap && feature.linkId === linkId) {
      return feature
    }
  }
  return null
}

function isSameLink(
  feature: Composition['features'][number],
  cap: string,
  linkId: string,
): boolean {
  return feature.kind === 'capLink' && feature.cap === cap && feature.linkId === linkId
}

/** The composition with this link pointing at `source` (added, or replacing the stored one). */
export function withCapLink(
  current: Composition | null,
  host: CompositionSourceRef,
  link: OfferedCapLink,
  source: CompositionSourceRef,
): Composition {
  const feature: CompositionCapLinkFeature = {
    kind: 'capLink',
    cap: link.cap,
    linkId: link.link.id,
    source,
  }
  const features = current?.features ?? []
  const index = features.findIndex((f) => isSameLink(f, link.cap, link.link.id))
  return {
    ...current,
    target: current?.target ?? { kind: 'existing', device: host },
    features:
      index === -1 ? [...features, feature] : features.map((f, i) => (i === index ? feature : f)),
  }
}

/**
 * The composition without this link. An existing device's customization has no
 * reason to stay once nothing is left (`null`: delete the block); a composed
 * device is the device itself, so it stays, naked (D1004).
 */
export function withoutCapLink(current: Composition, link: OfferedCapLink): Composition | null {
  const features = current.features.filter((f) => !isSameLink(f, link.cap, link.link.id))
  if (features.length === 0 && current.target.kind === 'existing') return null
  return { ...current, features }
}

/** Whether the table offers this link on a device of `deviceType` (a link names the types it is offered on). */
export function capLinkOfferedOn(link: CustomizeCapLink, deviceType: string): boolean {
  return link.deviceTypes?.some((type) => type === deviceType) === true
}

/**
 * What the cell shows for one link: the server's read when it answered
 * (`source-gone` and `disabled` come only from it), else what is stored.
 */
export function capLinkCellState(
  stored: CompositionCapLinkFeature | null,
  views: readonly CapLinkView[] | null,
  link: OfferedCapLink,
): CapLinkCellState {
  if (stored === null) return 'unlinked'
  const view = views?.find((v) => v.cap === link.cap && v.linkId === link.link.id)
  if (view !== undefined) return view.state
  return stored.enabled === false ? 'disabled' : 'linked'
}
