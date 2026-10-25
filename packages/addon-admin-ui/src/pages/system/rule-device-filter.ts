/**
 * The slice of a fleet device the notification pickers list (`listAll`
 * projection `slim`).
 *
 * The filtering, grouping and bulk actions that used to live here (a faceted
 * 293-row checklist) belong to the smart picker now — `device-picker-model.ts`,
 * shared with the viewer (D636). Two rules from that checklist carried over:
 * the groups are DERIVED from the devices present (never a hardcoded type
 * list), and bulk actions act on what the search shows, never on everything.
 */

/** The slice of a device this picker needs (`listAll` projection `slim`). */
export interface RuleDeviceOption {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly location: string | null
  /**
   * The device this one is attached to, when it has one. Absent means
   * TOP-LEVEL, never "unknown" — `resolveParentNames` renders an unresolvable
   * parent as `#<id>` rather than dropping it, exactly so this field can carry
   * that distinction.
   *
   * On this fleet it is the difference between a usable list and an unusable
   * one: nine devices are called "Temperatura" and the name alone cannot pick
   * between them.
   */
  readonly parentName?: string
}
