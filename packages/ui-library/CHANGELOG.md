# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
