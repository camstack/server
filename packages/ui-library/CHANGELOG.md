# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.359] - 2026-10-31

### Changed

- Pickers, dropdown menus and popovers now open on top of a modal dialog instead of behind it

## [1.2.358] - 2026-10-30

### Changed

- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone

## [1.2.357] - 2026-10-30

### Added

- Generated hooks for the new network scan and saved scan subnets calls

### Changed

- DevicePicker: fillHeight stretches the list to its container and scrolls the rows inside
- Dialog text now wraps when a dialog is opened from a table row action instead of scrolling sideways
- Collapsible section headers (settings sections, groups, device-picker groups, response log) use a larger chevron and are real buttons with keyboard support
- DialogContent accepts the native dialog attributes such as onCancel, so a caller can refuse Escape while work is in flight
- Renaming a node updates its name on the Cluster page immediately instead of after a reload

## [1.2.356] - 2026-10-30

### Changed

- Gateway device type has its own icon and label
- Generated hooks follow the broker sign-in methods field

## [1.2.355] - 2026-10-30

### Changed

- New QuantityValueInput: a number field with a unit picker for a physical quantity, showing a stored number in the unit it was picked in

## [1.2.354] - 2026-10-29

### Changed

- Generated hooks for the remote-layout-components capability

## [1.2.353] - 2026-10-29

### Changed

- The pet feeder card shows the food in the bowl with its unit (grams, or ounces with imperial units) instead of a bare number.

## [1.2.352] - 2026-10-29

### Changed

- Generated server-management hooks include installDesktopUpdate.

## [1.2.351] - 2026-10-29

### Added

- Generated hooks for the node launch overrides

## [1.2.350] - 2026-10-29

### Added

- The device export table also lists actions and notification targets, for the exporters that support them, with the same Expose toggle and type filter.
- Pages with a fixed-height body (Build-your-self Automations, Actions and Code tabs, OSD Manager) now scroll when their content is taller than the screen
- A pet fountain hero card with tank gauge, drinking totals and pump controls; the feeder shows the bowl in grams

### Changed

- server-management hooks gain the launch override methods (generated)

## [1.2.349] - 2026-10-29

### Changed

- Live detection boxes ignore out-of-order frames and fade by frame age
- Live detection boxes come straight from the detector; faces, plates and names attach as they arrive

## [1.2.348] - 2026-10-29

### Added

- Generated hooks for the new ir-transmitter and remote capabilities
- Generated system hooks for the template and remote capabilities
- Pet feeder: the manual-feed portion stepper responds instantly, repeats and speeds up while held, and starts from the last manual feed
- A device listed inside its container's own list no longer repeats the container's name; the prefix is also stripped after a hyphen or a colon.
- Readings follow the signed-in user's unit preferences (temperature in °C or °F, other quantities metric or imperial), read once from the account preference admin.units; the default stays metric and °C

## [1.2.347] - 2026-10-29

### Changed

- ItemFormDialog accepts fill, so a child can take the dialog's remaining height and scroll inside it

## [1.2.346] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery

## [1.2.345] - 2026-10-28

### Changed

- The device selector shows which addon and integration provides each device
- The climate control keeps the set temperature steady when it gains decimals, and the preset menu has no inner border
- Scrolling inside a dialog stays inside the dialog and no longer reaches the page behind it
- ⌘F / Ctrl+F jumps to the page's search field instead of the browser's find (new useHotkey / HotkeyProvider registry)

## [1.2.344] - 2026-10-28

### Changed

- The breadcrumb usage example links to the new per-addon integration URL

## [1.2.343] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.342] - 2026-10-28

### Changed

- Option lists can group options under headings, and a dropdown can be opened and closed from outside

## [1.2.341] - 2026-10-28

### Changed

- Account sign-in fields follow the vendor-login path of the hub login proxy

## [1.2.340] - 2026-10-27

### Changed

- The account sign-in form waits for the hub to finish the sign-in on its own and keeps the paste box as a fallback.

## [1.2.339] - 2026-10-27

### Added

- Generated hooks for the new Actions surface

## [1.2.338] - 2026-10-27

### Fixed

- The pet feeder panel shows the bowl amount and hides Mark refilled where the model cannot do it

## [1.2.337] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

### Fixed

- The pet feeder panel no longer draws the desiccant readout

## [1.2.336] - 2026-10-27

### Added

- CamStack UI Library (@camstack/ui-library).
