/**
 * The widgets the device page shows directly UNDER its hero card (D915):
 * every widget field of an aggregate section marked `location: 'hero'`. The
 * server emits such a section per binding of a cap that declares
 * `deviceConfig.ui.placement: 'hero'` — today `consumables` — so a device gets
 * the section exactly when it is bound to the cap, and this helper names no
 * widget and no device type.
 *
 * A container shows its PRIMARY child's hero widgets too (the same promotion
 * DeviceDetail applies to the child's top tabs), rendered against the child;
 * the container's own widget wins a collision, so the page never shows one
 * widget twice.
 */
/** The part of an aggregate section this helper reads — any section shape satisfies it. */
export interface HeroSectionView {
  readonly location?: string
  readonly order?: number
  readonly fields: readonly unknown[]
}

/** One hero widget, and the device it renders against. */
export interface HeroWidget {
  readonly widgetId: string
  readonly deviceId: number
  readonly order: number
}

/** One device's aggregate sections. */
export interface HeroWidgetSource {
  readonly sections: readonly HeroSectionView[]
  readonly deviceId: number
}

export interface HeroWidgetsInput extends HeroWidgetSource {
  /** The container's primary child, when the device is a container with one. */
  readonly child?: HeroWidgetSource
}

function widgetsOf(source: HeroWidgetSource): HeroWidget[] {
  return source.sections
    .filter((section) => section.location === 'hero')
    .flatMap((section) =>
      section.fields.flatMap((field): HeroWidget[] => {
        if (typeof field !== 'object' || field === null) return []
        const type: unknown = Reflect.get(field, 'type')
        const widgetId: unknown = Reflect.get(field, 'widgetId')
        if (type !== 'widget' || typeof widgetId !== 'string' || widgetId.length === 0) return []
        return [{ widgetId, deviceId: source.deviceId, order: section.order ?? 0 }]
      }),
    )
}

export function heroWidgets(input: HeroWidgetsInput): readonly HeroWidget[] {
  const own = widgetsOf(input)
  const ownIds = new Set(own.map((w) => w.widgetId))
  const promoted = input.child === undefined ? [] : widgetsOf(input.child)
  const merged = [...own, ...promoted.filter((w) => !ownIds.has(w.widgetId))]
  const seen = new Set<string>()
  return merged
    .filter((w) => {
      if (seen.has(w.widgetId)) return false
      seen.add(w.widgetId)
      return true
    })
    .sort((a, b) => a.order - b.order)
}
