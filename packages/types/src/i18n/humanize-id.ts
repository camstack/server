/**
 * Make a raw wire id readable when no dictionary knows it: `delivery_truck`
 * becomes "Delivery truck", `open-door` becomes "Open door". It invents no
 * translation — the words stay the id's own, only separators and the first
 * letter change. An empty id stays empty.
 */
export function humanizeId(id: string): string {
  const spaced = id.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
