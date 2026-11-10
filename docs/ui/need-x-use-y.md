---
title: Need X → use Y
last-verified: 2026-10-11
covers:
  - packages/ui-library/src/**
---

# Need X → use Y

One row per need, both clients. The admin column is `@camstack/ui-library`
unless the cell names an admin-ui path; the viewer column is the viewer kit
(`camstack/src/components/ui/`, a separate repository). `npm run ui:find`
searches this table and the library catalogue together, so keep the first
column in the words an author would type. Every name here exists — the
catalogue (`docs/reference/ui-components.json`) is generated from the
library's barrel; check a viewer name in the viewer repo's own catalogue.

| Need | Admin-ui / addon page | Viewer | Notes |
| --- | --- | --- | --- |
| A page with a title, subtitle and actions | `PageShell` (library); admin-ui may use `AdminPage` as a thin wrapper | `ScreenHeader` (`src/components/ScreenHeader.tsx`) | One chrome for admin and addon pages; optional `nav` under the title |
| A section header row of filters / node / Add | `SectionToolbar` inside `SectionCard` | — | Left = filters/node; right = Add |
| Create or edit a named list item in a modal | `ItemFormDialog` + `useItemFormUrl` (`?new=1` / `?edit=`) | — | Same dialog for Add and Edit; canvas editors are the exception. Ref: NC Rules |
| A grid of images / event cards | `MediaGrid` + `MediaCard` | — | Not a page-local CSS grid |
| A single number with a label (page KPI strip) | `StatCard` + `GRID_QUICK_STATS` | — | Widget panels: `WidgetMetricCard` (same geometry) |
| Tabs on a page, deep-linkable | `AdminTabs` (admin-ui, `?tab=`) | `SegmentedControl` / `SegmentBlock` | Never a second `?tab=` strip inside an `AdminTabs` page |
| Tabs inside a card or dialog | `Tabs` + `TabsList` + `TabsTrigger` + `TabsContent` | `SegmentedControl` | |
| The integrations of one kind, one on screen | `IntegrationHub` + `AddonIntegrationBody` (admin-ui `components/integration-hub/`) | — | Pills are the context switcher; selection in `?integration=` |
| Credential entries of one provider collection (multi-entry) | `ProviderEntryPills` + `AddProviderEntryDialog` | — | Pills are **entries** only; Add lists **types** from the host; selection is a callback (host owns `?entry=`) |
| Multi-select trainable base models for a training job | `TrainingBaseModelPicker` (+ `mapRootDetectorPlacements`) | — | Rows list every `node · device` placement; Select-all-roots = cluster root detectors only |
| A list of manageable items (rules, tokens, sessions, targets) | `DataTable` with `maxBodyHeight={TABLE_SCROLL_MAX_H}` | `Section` + `Row` list | Never a Card stack or `div` stack: the questions are per column. Pair with `ItemFormDialog` for create/edit |
| Search and facet filters over a table | `DataTableFilterBar` + `useDataTableFilter` (`facetGroups` for several chip rows) | `FilterChip`, `ChipMultiselect` | Many groups or many values: `display: 'menu'` on the group draws one compact multi-select trigger per group instead of chips |
| Every stored record kind (entries editable, the rest read-only) | `DataRecordsHub` | — | System → Data → Records; deleted-device data is its second view, not a tab |
| Sort a table column | `DataColumn.sortValue` (raw value; `null` sorts last) or `notSortableReason`; controlled: `sort` + `onSortChange` | — | |
| Paginate a table | `DataTable` `pageSize` (+ `page` / `onPageChange`); a remembered size: `PageSizeSelect` + `usePersistedPageSize` | — | |
| Select rows for a bulk action | `DataTable` `selection` (needs `rowKey`) | — | Bulk = selection → preview → exact ids, never a predicate |
| A table of devices | `DeviceList` | — | `DeviceList mode="generic"` for rows that expand |
| A device row (mini scene, name + status line, control, fact) | `DeviceRow` | — | Four fixed zones; the fact hides below `sm`. The mini scene is `HeroScene size="mini"` with the same scene id as the hero |
| A device hero card, layout A | `HeroCardA` + `HeroScene` | — | One-line top row, scene (id + state + params from the hero model), rows, foot. One animation per state; reduced motion stops it |
| Switch a list between table and grid | `ViewSwitch` | — | The control remembers nothing. The page stores the choice (the page-size pattern: guarded `localStorage`, a safe default). One option is not rendered. `DataTable` itself never becomes a card stack |
| A label / value setting row | `SettingRow` inside `SectionCard` | `Row`, `ToggleRow`, `SelectRow`, `StepperRow` inside `Section` | `SettingRow` stacks below `sm` |
| A form generated from a settings schema | `ConfigFormBuilder` (`AddonScopedSettingsForm` for one capability's scope of an addon) | — | Placement follows the schema, see `docs/architecture/ui.md` |
| A labelled form field | `FormField` + `Input` / `Select` / `Checkbox` / `Switch` | `ToggleRow`, `SelectRow` | |
| A password, token or API key field | `PasswordInput`; `SecretFieldControl` for a keychain-backed setting | — | The form never holds a stored value; the eye reveals through the audited `keychain-admin.reveal` (`SecretRevealProvider`). See `docs/architecture/secrets-keychain.md` |
| Copy a value | `CopyButton` | — | |
| A modal dialog | `Dialog` + `DialogContent` (+ `DialogHeader`, `DialogBody`, `DialogFooter`) | `SheetModal` | `scroll="body"` when tall; `placement="sheet-on-mobile"` |
| A list to pick one item from, in a sheet | `Dialog` + list | `PickerSheet` | |
| Confirm before a destructive action | `ConfirmActionButton`, or `useConfirm` | `useConfirm` (`src/components/ui/confirm.tsx`) | Never `window.confirm` |
| Ask for one value | `usePrompt` | `usePrompt` | |
| Tell the operator something once | `useAlert` | `useNotice` | |
| A secondary-actions menu | `KebabMenu` | `AnchoredMenu` | |
| A dropdown of options | `Dropdown` + `DropdownTrigger` + `DropdownContent` + `DropdownItem`, or `Select` | `AnchoredDropdown`, `SelectRow` | |
| An icon-only button | `IconButton` (with `aria-label`) | — | |
| A button | `Button` | — | |
| A status pill | `StatusBadge`, `Badge` | `ConnectingIndicator`, `ProgressStrip` | |
| A battery / network / provider / version marker | `BatteryBadge`, `NetworkLinkBadge`, `ProviderBadge`, `VersionBadge` | — | |
| A consumable's level (salt, rinse aid, a filter, a brush, a tank) | `ConsumableLevelBadge` (+ `consumableItemLevel` for a `consumables` item, by its `kind`) | — | The one level → tone map: ok success, low warning, empty danger, full warning, unknown neutral; the state is always in words. A device's consumables are never drawn by its hero card: the `consumables` cap's `ConsumablesPanel` sits directly under it, drawn per item `form` (part, tank, product, bin) and collapsed unless an item needs attention (D915) |
| Nothing to show yet | `EmptyState` | — | Loading is not empty: ask `useCapabilityPresence` |
| An error or warning box | `ErrorBox` | `RenderErrorBoundary` | |
| A loading placeholder | `Skeleton` | `SkeletonBox` | |
| A tooltip | `Tooltip` + `TooltipTrigger` + `TooltipContent` | `Tooltip` | |
| A card that collapses | `CollapsibleCard` | — | |
| An expand / collapse marker on a header (the header itself is a `<button type="button" aria-expanded>`) | `DisclosureChevron` | a `▸` / `▾` text glyph (`check-no-glyph-chevrons`) | |
| A key/value list | `KeyValueList` | `Row` | |
| A single number with a label | `StatCard` (see KPI strip row above) | — | |
| Pick a cluster node | `NodePicker` (standard), `NodeSelectField` in a form | — | Offline nodes disabled; hidden on a single-node cluster |
| Pick a device, or a VALUE of a capability on a device (one or several) | `DeviceValuePicker` (`requires`, `multiple`, `variant` `inline` / `popover`, `pick` `value` / `device`). A schema form's `device-select` / `device-multiselect` render it | `DevicePicker` (viewer, until its sheet lands) | Backed by `deviceManager.search`: only compatible devices, one generic "No device provides {capability}" message (`capabilityLabel`), failed is not empty. A device with several values opens a second level. A form stores the device id string as before. `DeviceSelectField` / `DeviceMultiSelectField` remain only for a union `caps`+`types` filter or `suggestLocation` until their call sites migrate |
| A device's name | `DeviceName` (`compact` in lists, pickers, history, export and alarms; `full` on the page title, breadcrumb, hero and confirms; `nested` under a parent row; `with-location` when the room is not already on the line) | `formatDeviceName` in `src/data/device-name.ts` (not yet on screens) | One rule. The stored name stays in search and in the identity editor. Parent names come from one slim fleet list |
| Pick the device and value that feed a Customize extension, or the members of a group helper | `SourceSelector` (`components/device/customize/source-selector/SourceSelector.tsx`) | — | Wraps `DeviceValueField`. `kind: 'members'` is the multi-select a group helper asks for (`SourcePickRequest`: one device type, the catalog fields, direct matches only). Behaviour params for an extension still come from the customize catalog (D944) |
| A text that may carry device values (`{{ alias.field }}`): an action argument, a notification rule or digest (summary, timelapse) title or body | `DeviceTemplateField` (`accepts`, `preview`, `handle` to insert at the caret) | a plain `Input` | Device references show as chips; the insert control offers only fields that fit `accepts`; the hub's verdict (`checkDeviceTemplates`) shows under the field. A text the hub does not render as a template (the Texts catalog sentences, an AI question) stays plain; `TemplateField` takes `deviceValues={false}` for it. An evaluator expression (formula, automation condition) is not a template: use `ExpressionInput` |
| Pick ONE device value (device, then cap, then field; only what fits) | `DeviceValueField` + `useDeviceValueSource` | `DevicePicker`, a second value list | Never lists an incompatible device or value. A chosen source is one compact card (source row with Change, transform, proposal, preview); picking is two columns from `sm`, one accordion list on a phone. Adapters add what the pick means (a transform and a preview, or a token) |
| Pick a timezone / icon / unit / model | `TimezoneSelector`, `IconPicker`, `UnitPicker`, `ModelPicker` | — | |
| Enter a number tied to a physical quantity (a threshold, a portion) | `QuantityValueInput` (stored number plus the unit the person picks; emits `{ value, unit }`) | — | A bare `Input type="number"` on a quantity field is the bug it exists to prevent |
| Live camera video | `CameraStreamPlayer`, `StreamPanel` | the embed player (`embed/`) | WebRTC only |
| A live log or event tail | `LogStream`, `EventStream` | — | |
| A bottom sheet / side drawer on mobile | `BottomSheet`, `MobileDrawer` | `SheetModal` | |
| Code or JSON shown verbatim | `CodeBlock` | — | |
| A QR code | `QrCode` | — | |
| A paged carousel | — | `CarouselPager` | |
| A chart over time | `TimeSeriesChart`, `StateTimeline`, `BarSeries`, `Sparkline` (D899) | — | One unit per chart on a device surface; slots, never hex; the selected point's tooltip is built into the chart (mouse, touch, arrow keys). `Tooltip` is for a control hint. See `admin-patterns.md` |
| Points on a 24 h day the operator drags (a scheduler's timeline) | `TimelineSlider` | — | Markers move in whole steps by pointer or arrow keys (shift = one hour) and report a minute of the day; the page maps it to its data. `bands` paint a stretch such as a hold |
| A device's recorded history | `DeviceHistoryView` | — | The device History tab and the camera Live Stats tab are the same component |
