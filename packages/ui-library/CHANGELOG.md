# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.513] - 2026-11-26

### Changed

- Rebuilt against updated dependencies.

## [1.2.512] - 2026-11-26

### Changed

- Generated hooks for the cluster detection defaults plan/apply methods

## [1.2.511] - 2026-11-26

### Changed

- Device picker: a new 'action' noun for picking actions
- Device rows share one bindings fetch per device and one binding/state subscription instead of opening several per row, so long device lists load faster
- The time input offers 'after day or night starts' plus minutes

## [1.2.510] - 2026-11-26

### Changed

- The device extension slot card sends the version it read when saving

## [1.2.509] - 2026-11-26

### Changed

- The Export logs dialog has an Export as ZIP checkbox, and its hint says an empty selection exports the whole system log.

## [1.2.508] - 2026-11-25

### Changed

- Generated hooks for the device manager's adopt mode and adoption records

## [1.2.507] - 2026-11-25

### Changed

- Recorded playback logs why the picture freezes after a seek (keyframes decoded, PLI/NACK, loss, time to first decode)
- A sensor reading without a trend line (motion, contact) now shows only its own history instead of the device's whole history

## [1.2.506] - 2026-11-25

### Changed

- The device card battery corner shows the low/ok state of a binary battery source and its voltage (for example 2.9 V) beside it.
- The battery corner icon turns red when the battery is low and stays muted while only a voltage is known

## [1.2.505] - 2026-11-25

### Changed

- Sensor pie card: each quantity's wedge has its own clearly visible colour and edge (motion is now violet), and tapping a wedge highlights it and shows its chart below the pie instead of a dialog

## [1.2.504] - 2026-11-24

### Changed

- The timed run is one compact control on every card and row of a device that supports it: the one-tap duration is edited next to the start button, and the row no longer squeezes it.
- Device lists no longer trap the page scroll when the parent gives them no height; the formula input shows suggestions only while focused
- A sensor with several readings (motion and light, temperature and humidity…) is one card: a pie with a wedge per reading that breathes when active, with a +N wedge past six; a container card counts its devices online, offline and low on battery.

## [1.2.503] - 2026-11-24

### Changed

- The device list's scroller no longer hands a fast scroll to the page behind a modal, which made the screen flash

## [1.2.502] - 2026-11-24

### Changed

- Plain switches, plugs and fans show the on-for timer on their card

## [1.2.501] - 2026-11-24

### Changed

- A PoE port's device card draws a LAN port whose link lights blink while the port is on.
- Every duration field is now the same hours / minutes / seconds / milliseconds input, including the recording segment length, the event post-buffer and the timed-run box; the stored values do not change.
- A daily window and a time of day are one input everywhere: clock or sunrise / sunset with an offset, a range over midnight, Day / Night and weekdays (TimeWindowInput, TimeSpecInput, the time-window settings field).
- A time-window settings field keeps an invalid draft on screen with its error, the sun offset commits whole minutes on blur, and a stored whole-day window stays named when weekdays are off
- Apps for the viewer shell are declared through the app-source capability and listed, filtered by role, by the apps capability.
- The notification schedule windows and the recording bands edit their time window with the shared time-window input (two clock times and the weekdays); stored schedules and bands are unchanged

## [1.2.500] - 2026-11-24

### Added

- New DurationPartsInput: a length of time typed as hours, minutes and seconds side by side.
- Export MultiSelectDropdown for addon pages

### Changed

- DataTable: a fifth phone column role, sheet — columns with an input leave the phone row and open in a bottom sheet when the row is tapped (sheetOpenLabel keeps the row action reachable)
- Generated device-manager hooks include repairMigrationSecrets.
- Generated hooks follow the rooms-and-tags-as-records capability changes.
- A table row's destructive action (DataTable column render gets table.destructive) now confirms, then shows the row as pending until it settles; useConfirm() takes an optional async action that keeps its dialog open with a spinner and shows a failure inside it; new useDestructiveAction hook
- Device table: a device type with no inline control now leaves its cell empty instead of showing a dash
- DurationInput: hours, minutes, seconds and milliseconds fields over a value stored in ms or s; settings forms render it for a duration field
- Autotrack, scene settings and the home-return delay now save with Save / Discard instead of on blur, delays are entered as hours, minutes and seconds, and a grid cell's source is picked with the device picker
- The scene settings form always shows Save and Discard while edits are pending, and says why a blank name or question cannot be saved.
- A motion-trigger toggle on a device card, row or hero reads 'not read yet' instead of 'off' until the camera has been read; it can still be set.

## [1.2.499] - 2026-11-22

### Changed

- History charts stored in metres switch between km, mi and m by your unit preference; rain in mm is unchanged
- Consumable rows show a distance remaining in km or miles by your unit preference
- Device labels and icons for the vehicle lock, vehicle climate and TV roles
- A vehicle device type label and a car and tv glyph in the fast icon table
- Generated hooks for the new location capability
- Generated hooks for the new vehicle capability
- Device list: on a phone the name column keeps a readable minimum width and the table scrolls sideways instead of crushing it
- Device History: the value axis no longer repeats the unit in every tick label and its column is narrower, so charts span more width
- Energy card: today's day chart now ends at the current time instead of stopping short of it; past days stay full-day
- Device card history: outcomes read Done, Failed or By the device.
- New generated hook for the template instances read (coreBlocks.listTemplateInstances)
- Tables on a phone: DataTable columns declare a required mobile role (primary, keep, detail, hidden) and fold instead of scrolling sideways; device rows stay one line tall with the full name, and their actions (the device's main action first, then Open and Delete) sit behind a swipe, reachable from the keyboard too; new SwipeActions primitive and PageActions composite; the Per page selector keeps its chevron and stays on one line.
- LogStream folds its scope, integration and device columns into a line under the message on a phone
- Generic device lists keep their first column inside a phone screen, and the pager fits one line there
- Phone tables: a detail line wraps instead of clipping, so a control inside it stays reachable; the confirm dialog keeps its exit animation and clears a stale error when reopened

## [1.2.498] - 2026-11-22

### Changed

- Cap link cell for the Customize table, and the energy card reads the linked heat pump with its COP.

## [1.2.497] - 2026-11-22

### Fixed

- Sensor rows show a reading with the precision the device reports

## [1.2.496] - 2026-11-22

### Changed

- Device tables: the name column fills the width the controls leave and ellipsises on the right on a phone (no sideways scroll or left clip), and row state labels, readouts and the timed-run buttons use the row's own text size
- Generated hooks include pipelineOrchestrator.getNodeCapacityVerdict.

## [1.2.495] - 2026-11-21

### Changed

- The upstream-supply popover on a device card is more compact: Turn on, Turn off and Restart are one button group, and a switch that cannot be commanded shows Restart only

## [1.2.494] - 2026-11-21

### Changed

- Every number follows one rule: the precision you set wins, otherwise at most two decimals with trailing zeros trimmed; cards, charts and the energy card honour the device's Precision from Customize

## [1.2.493] - 2026-11-21

### Changed

- Generated hooks for the whole-capability link methods of core-blocks.

## [1.2.492] - 2026-11-21

### Changed

- A History chart titled by its unit follows the shown unit, and a value below 0.001 reads as below it instead of 0
- History charts use the full width of their card, and a power or energy chart follows the device display unit, the unit picker, or scales to kW / kWh / MWh in the thousands on the axis, tooltip and readout

## [1.2.491] - 2026-11-21

### Changed

- Energy card: a grid with no answered power reading shows a dash instead of 0 W, a dead or storage-blind counter leaves the day balance unknown, and today's household is derived when the house day total is missing
- The energy card reads a past day from its energy balance (consumption, autarky, source split), shows imported / exported / produced and the autarky in the centre, draws the nodes and arrows from that day's kWh, and keeps a flat counter at 0 instead of a dash; live arrows now all carry arrowheads and the grid node stays when it reads 0 W

## [1.2.490] - 2026-11-21

### Changed

- The device card footer trend now shows its scale: min and max with the unit, the time span (start to now) and the latest value
### Changed


## [1.2.489] - 2026-11-21

### Changed

- Export panel: an Alexa link whose proactive updates are paused reads 'Linked — proactive updates paused', and a status that has not answered reads 'Unknown' instead of 'Unlinked'

## [1.2.488] - 2026-11-21

### Changed

- The stream selector in the camera player toolbar shows a single dropdown arrow instead of two.

## [1.2.487] - 2026-11-21

### Changed

- The condition kind picker has icons for the two device-fault rows.
- Cover cards: the closure / opening slider row is now centred under the drawing instead of sitting on the left edge
- Device cards can switch off the History / Actions view their state line opens, per card or for a whole host
- The camera card now renders through the standard device card with a full-width scene: battery, sleep and motion sit in the card frame above the player, nothing is drawn over the video, and History uses the shared state/history view
- The device card lists every active fault of the device (the error capability) in its frame under the name, and a mower in error now says Error in its state pill with the cause in that row

## [1.2.486] - 2026-11-21

### Changed

- Camera card: the Show zones switch only appears when the camera has zones
- Zone editor: StreamPanel and the player overlay registry accept an image-placed layer, drawn inside the picture's own rect instead of the whole 16:9 box

## [1.2.485] - 2026-11-20

### Changed

- Adding a notifier no longer offers a discovered device that is already a target: it is listed as already added, with the target's name, and cannot be picked again.
- A camera's device card opens its history in the card's own bounded History view instead of stretching the page
- StreamPanel can offer a snapshot download and draw detection boxes on the snapshot
- A camera snapshot draws detection boxes and motion inside the image's own rect, so a rotated or 4:3 camera is no longer offset
- StreamPanel: a Show zones switch (off by default, read-only ZonesReadOnlyLayer sharing the zone editor's drawing model) and live-view overlays now follow the video's real picture rect instead of the letterboxed box

## [1.2.484] - 2026-11-20

### Changed

- A Select list that opens above its field now sits right over it instead of floating far above, and a select with a default value no longer offers the empty "— Select —" entry.
- A camera device card: the live view full width with state chips (charge, power source, asleep or awake, last motion) over it and the device history under it

## [1.2.483] - 2026-11-20

### Fixed

- The device list type and integration filters open above the table instead of adding scrollbars, and the list scrolls inside the height it is given

## [1.2.482] - 2026-11-20

### Added

- The recording band editor offers a battery range on battery cameras and warns when a charge level records nothing.

## [1.2.481] - 2026-11-20

### Changed

- Event filter: pick from the catalogued event categories, grouped and labelled, or add a custom pattern (an exact id or prefix.*)

## [1.2.480] - 2026-11-20

### Changed

- The camera grid's per-cell crop canvas is now a shared piece, and its rectangle and grips use the theme's primary colour

## [1.2.479] - 2026-11-20

### Changed

- The battery badge on the device page now opens the power source, charge state, voltage, current, temperature, sleep state and last contact; unknown values are left out.

## [1.2.478] - 2026-11-20

### Changed

- The Energy system card has a day selector with a time-axis power chart, and an enlarged centre circle showing self-sufficiency, self-consumption and the net grid of the selected day
- Energy card: chart lines share their scene node's colour, chart times follow the UI language, a legend explains the flow bands, and past days dim the live scene
- Energy card: the centre circle keeps its size and shows one day figure at a time; tap or Enter cycles self-sufficiency, self-consumption and net grid

## [1.2.477] - 2026-11-19

### Changed

- FormSaveBar: the sticky Save / Discard bar is now a library composite on an opaque surface, so text no longer shows through it

## [1.2.476] - 2026-11-19

### Changed

- Integration switch hooks follow the hub registry (listByAddon, adoptInstanceRows)
- Light and floodlight device cards now show an On motion toggle when the device supports it, shared with the siren card.
- Every device card whose device supports it now shows an On motion icon toggle in the bottom-left corner (the siren's own text toggle is gone); the siren's Sound and Stop buttons are icons with a spinner while a command is in flight.

## [1.2.475] - 2026-11-19

### Changed

- Opening an editor in Build-your-self adds a history entry, so Back returns to the list
- The grouped tile picker can show a search field that filters tiles across sections
- Device rows: the quick-action button now opens the device page (arrow-up-right icon); the web interface link moved into the device detail.

## [1.2.474] - 2026-11-19

### Changed

- DeviceStepMatrix takes an optional stepAction slot drawn under each step's name, beside (not inside) the step header button
- Generated hooks for the stream-broker previewDerivedEncode method.

## [1.2.473] - 2026-11-18

### Changed

- Clicking a device row opens the quick-detail modal when the host provides one; the cog glyph is gone

## [1.2.472] - 2026-11-18

### Added

- Generated hooks for the new pipeline step switch methods.
## [1.2.471] - 2026-11-18

### Changed

- A device's history shows every chart stacked and always visible; the collapsible Single charts group is gone
- Device history charts hold the last known value as a flat line up to now, and an opened history keeps room for the stacked charts
- A UPS device is drawn with a charging-battery icon

## [1.2.470] - 2026-11-18

### Changed

- Hooks for listing identity links and confirming, dismissing or unlinking them.

## [1.2.469] - 2026-11-18

### Changed

- Regenerated hooks for the new device-state-refresh capability.
- The workload card's hero shows a state dot with the uptime, CPU and RAM gauges (a dash when not reported), and only the start, stop and restart actions the device supports; stop asks twice.
- The siren card is one big Sound button that becomes Stop while it sounds, inside a ring counting down the reported time left; duration, plays and sound-on-motion appear only when the siren offers them.

## [1.2.468] - 2026-11-18

### Changed

- Device controls show the state the hub serves: a command's new value now comes from the hub and is the same on every screen, and a refused command is still reported
- Device sliders (brightness, colour temperature, fan speed, volume, position, tilt, target humidity, light level) send one command when released and no longer snap back while dragged
- Feed and Run buttons are disabled while their command is in flight, so a double tap sends one command; the cover and valve levers send one command on release, also when the pointer is let go outside the control.

## [1.2.467] - 2026-11-17

### Changed

- Generated hooks follow the new low-power-sleep and resync capabilities
- The plug card shows a two-step Restart button when its switch can power-cycle the device it feeds (a PoE port).

## [1.2.466] - 2026-11-17

### Changed

- Alarm cards ask for a code when the panel needs one or cannot tell (codeRequired).

## [1.2.465] - 2026-11-17

### Changed

- device-manager.listIdentityCandidates lists devices of different integrations that share hardware identifiers (auto / proposal confidence); read-only, no links yet

## [1.2.464] - 2026-11-17

### Added

- Workload devices get their type and role names and icons
- PoE port devices get their role name and an ethernet-port icon

### Changed

- A workload (VM, container, app, host) has its own device card: state, the actions it supports, its resources and facts, and a link to its host
- The camera grid layout editor is available to the block editor.
- Siren play-choices hook from the regenerated capability hooks
- Generated hooks for switch getOptions and powerCycle.
- The hero power menu offers only the restart when the supply's switch only reports (D1058)
- Generated hooks include deviceManager.setIdentifiers.

## [1.2.463] - 2026-11-16

### Changed

- RecordingTimeline reports its window and takes caller density and extra lanes; new ClipSourceLanes draws one clip lane per source a camera lists.
- RecordingTimeline takes a toolbar slot that joins the date and zoom controls in one bar; clip source lanes are compact rows with the label inline.
- useCapabilityNodePresence also reports the nodes that run a provider (pending and unknown kept distinct from none).
- The tag manager refreshes the notification rules list after a rename or remove
- The archive timeline shows one lane per clip source and joins the date and zoom controls in one bar
- Siren play-choices hook from the regenerated capability hooks

## [1.2.462] - 2026-11-16

### Changed

- Device Interactions show the add-on by name and, for an exporter, who it acted for.
- Regenerated system hooks for the new timed siren capability
- Every log stream now offers Export (pre-filled with its scope, with a choice of log source showing whether it is readable and how far back it reaches), shows the integration and device names with a column picker, and the device picker no longer jumps while it loads
- Log stream name columns are off unless a page opts in through the columns prop; the export dialog shows an error when the log sources cannot be read
- The recording timeline opens on the latest footage, says so when a window is empty, and a range dragged on it can start an export.

## [1.2.461] - 2026-11-16

### Changed

- Device card: History and Remote overlays keep the detail's height (or fill the host's) with a pinned top and one scrolling region; Interactions are grouped by day with one-line rows and no outcome badge; History opens on one block of lanes per unit with a Points selector, single charts collapsed

## [1.2.460] - 2026-11-16

### Changed

- SectionCard gains a fill option so a section can take the full available height and scroll inside

## [1.2.459] - 2026-11-16

### Changed

- Generated hooks include the pipeline-orchestrator health digest query
- Closing a nested dialog (Insert value, Function) returns to the dialog it was opened from instead of closing everything; the device-template field puts its Device value, Function and help buttons above the input on full-width rows.

## [1.2.458] - 2026-11-15

### Changed

- Tags: a shared tag input, chips, a per-list tag filter with a List / By tag view, and a colour-and-icon dialog for a tag
- Tags filter uses the shared table filter bar; the device list keeps its pager in By-tag view

## [1.2.457] - 2026-11-15

### Changed

- Account sign-in field: the form passes its action handler, so Sign in again / Sign out work when editing an existing integration; with no handler the buttons are disabled and say why

## [1.2.456] - 2026-11-15

### Changed

- Template editor: the help tooltip is a collision-aware popover, toolbar buttons align, function parameters offer pickers and inline suggestions, and the Insert a device value columns are resizable and remembered

## [1.2.455] - 2026-11-15

### Changed

- Device History draws one chart per value unless the capability groups them, counters as per-period bars, with a per-chart unit switch
- Energy, weather-station and climate cards now show a 24-hour trend of the device's primary series, and a history chart with an unknown unit shows no unit and no unit switch

## [1.2.454] - 2026-11-15
### Fixed

- Device history charts in one view now share the same left and right gutter, so the crosshair and selected point line up across charts

## [1.2.453] - 2026-11-15

### Changed

- Generated hooks for the new tags capability (list, setStyle, rename, remove) and the device setTags method
- A device template field inserts device values and functions, completes with Ctrl+Space, and previews through the hub.

## [1.2.452] - 2026-11-15

### Changed

- Energy card: the heat pump share is computed against house plus heat pump and stays within 0-100%

## [1.2.451] - 2026-11-15

### Changed

- The device card's consumables chip now carries everything the removed Consumables section showed: a full bin or tank warns, an unknown reading never reads as ok, remaining time, Replaced date, the state in words, Reset, and the empty and loading lines.

## [1.2.450] - 2026-11-15

### Changed

- Device card History: the Runs table no longer scrolls inside the card, each interaction shows its exact time with an inline details button, and a chip row picks which points the history charts show

## [1.2.449] - 2026-11-15

### Added

- Hooks for the node server shell (enabled state and refusal reason).

## [1.2.448] - 2026-11-15

### Fixed

- Typing in the device search on a phone no longer crashes the page with a React error when the filters collapse

## [1.2.447] - 2026-11-14

### Changed

- Climate card gauge: target large in the centre with the current temperature under it, a hollow marker at the room temperature, and the band to the target only while the device reports heating or cooling; the activity label follows the reported action instead of target versus room. The idle state reads "Inattivo" in Italian.
- A device-and-value field can show its value column before a device is picked.
- The weather station card draws the sensors the station reports — cups that spin with the wind, a vane that turns to the direction — and groups the readings into categories.
- Every device card shows a badge when the device reports a fault.

## [1.2.446] - 2026-11-14

### Added

- A weather station has its own device card: temperature beside the sky, and a dash where the station reports nothing.

## [1.2.445] - 2026-11-14

### Changed

- generated hooks for the control cap's new next/previous/first/last methods

## [1.2.444] - 2026-11-14

### Changed

- The device pickers' phone sheet keeps the filter panel above the search box instead of painting over it, and the sheet can be dismissed by dragging its handle down.
## [1.2.443] - 2026-11-14

### Changed

- Device cards: the two side columns are equal (15% each) and take only compact controls, so selectors now sit below the scene; the scene keeps at least 70% of the width and a power-only device toggles by a tap on the drawing (climate, media and energy first)
- Device cards: every card now has the same fixed layout, two equal side columns with only compact controls and values, the drawing filling the middle, and selectors and long text below
- Device cards: the area below the drawing is now a list of configurable rows (selectors, pills, stats, buttons, a slider, text), and Energy groups its thirteen totals into three compact rows
- Device cards: every bottom row is a typed kind (no free node), row captions are translated, and narrow phones no longer cut column readings and stats labels
- Device picker: the selected device is named with its parent like everywhere else, the Integration filter shows which provider each instance belongs to, and the closed field is as tall as a select
- Device picker: an event mode (DeviceEventPicker) picks several events of several devices in one field — device, then its parts and events
- The device picker has an action mode: one field lists the chosen actions and a two-step picker (devices, then the action they share and its args) adds or edits one
- The device picker's event mode yields whole device-fired triggers and its action mode whole command steps, with a By room/type choice for an action's target

## [1.2.442] - 2026-11-14

### Changed

- A siren card stays pending until its switch answers, instead of looking blank or silent.
- The energy card no longer repeats the battery charge as a Charge pill when the scene already shows it.
- Device lists no longer treat a hub parent as a device type. Labels, icons and controls no longer include it.
- A device card reports when it has finished loading, including a fallback.

## [1.2.441] - 2026-11-14

### Changed

- Device rows for control, button, script, automation, update and event types are drawn from the projected row model; the parallel inline controls are removed
- The device picker names a device's provider by its addon alone, without the integration instance
- The media card's mute key is momentary when the player cannot read the mute back, and no longer writes 'muted'
- The energy-system card shows its totals of today as value pills, and imported, exported and heat pump totals name kWh
- A container's child reads as a part (its primary child as primary); only a hub, NVR or gateway child is adopted. Energy rows show solar and storage as separate pills.
- The energy-system card shows today's balance, self-sufficiency, battery autonomy and the heat pump's share of the house load.
- The media card treats mute as a reading only when the player says it reads mute back

## [1.2.440] - 2026-11-13

### Changed

- The update card names the install step in your language on one line instead of the provider's raw code
- A simple sensor (one reading, nothing to set) is drawn in the shared device card: its value once with the quantity icon, the backdrop behind it, and the state corner that opens the history.

### Fixed

- An event source card names which button fired, and lists each button's events when several share a name.

## [1.2.439] - 2026-11-13

### Added

- The admin client can run Toggle on a switch.

### Changed

- The device picker shows each device's parent, keeps the filter rail visible on desktop, opens wider, and no longer re-orders or scrolls the list when you select a device
- A full-height form dialog now has a fixed height on desktop, so only its columns scroll while the title and buttons stay put
- The device picker panel can fill a dialog column and label an action requirement.
- The pager under a table names previous and next with a tooltip.
- Device cards for locks, alarm panels, humidifiers, valves, sirens, pet feeders and fountains, and weather stations: two-step unlock and siren, alarm codes typed on a pad and sent only with the command, a lock that refuses to close beside an open door.
- Device cards for buttons, updates, scripts, automations, controls (number, choice, text, date), event sources, images, notifiers and gateways, drawn from what each device declares

### Fixed

- A device card restores a fountain's pump cycle and water volume, a feeder's own battery, a valve position only when the device is positionable, weather in the chosen units, Open door on an unlocked lock, and an unknown pump or siren that is not drawn as off.
## [1.2.438] - 2026-11-13

### Changed

- Instance pickers list a Google account wherever a mail sender is asked for.
- A link picker names each instance with its status (Signed in, Not signed in), so a sender that is not ready says so before it is picked
- Energy system devices show the energy-flow card on their page and solar power and storage charge in the device list

## [1.2.437] - 2026-11-13

### Added

- A device card's History view opens on the recorded values, and a section switch shows who changed them when the device can record actuations

### Changed

- Device hooks regenerated for the capability vocabulary now declared on each capability (no behaviour change)

## [1.2.436] - 2026-11-13

### Changed

- Device cards and controls show an empty — for a value not yet reported, drop the Online chip and the Online tooltip on a device row's status dot (offline still shows), and lists in a select or dropdown scroll without the panel jumping back

## [1.2.435] - 2026-11-13

### Changed

- A switch with the role switch-light gets the light card (bulb and glow, no slider) and a bulb icon
- A device card no longer shows a duration since 1970 when the change time is only a seed — including the offline line and a running cycle — and a temperature slider follows the display unit, storing the nearest step of the device's own unit.
- A heat-only thermostat in auto above its target shows idle on the device card, never COOLING; cooling is derived only for a device that offers a cooling mode
- A sensor with no reading shows its normal card with an empty value (—) and its unit instead of Awaiting state…
- A climate device that reports no modes keeps showing cooling in auto above its target; only a device whose reported modes cannot cool reads idle

## [1.2.434] - 2026-11-12

### Changed

- Device card: a bare frame (no border, surface or top line) for hosts that draw their own header, such as the viewer's device sheet
- A heat pump is drawn as the shared device card: outdoor, flow and return temperatures, compressor, thermal/electrical power and COP, a picker per circuit, and every system mode it declares (silent, away, additional heater, holiday).
- A water heater's hero is now the shared device card: the target stepped within the device's range, the tank filled to the water temperature, power through its off mode, mode and away.
- An energy system has its own device card: solar, grid, battery, home and heat pump as branches of one bus, dots running in or out at the speed of each power, and today's totals. Drawn from fixtures only until a provider exposes one energy-system device (#513).

## [1.2.433] - 2026-11-12

### Changed

- Generated hooks include deviceExport.setExposedName.
- A simple sensor's card shows its reading once, big, over a scene that says what it means; sensor and control rows draw the same model, follow your display units (°F, kW, precision), send a typed value in the device's own unit, and a device list reads its row values in one request
- The device value picker can open straight on its two columns, and its grouped value list is available on its own
- The condition kind picker picks the first row again when Enter is pressed on an empty search while adding a row

## [1.2.432] - 2026-11-12

### Changed

- An offline device card says Offline once, in its top line, instead of repeating it under the controls
- A dialog that contains a search field focuses it when it opens.
- Device list rows show a sensor reading published only on numeric-sensor, including whole numbers.

## [1.2.431] - 2026-11-12

### Changed

- The device card of a container (and any card in a narrow column) stacks its controls under the drawing instead of cutting them off
- System hooks include the ir-transmitter learn method
## [1.2.430] - 2026-11-12

### Changed

- A media player card with a known volume and an absolute set shows a slider; an unknown level, or volume up and down only, keeps the minus and plus buttons

## [1.2.429] - 2026-11-12

### Changed

- Washer, dryer, dishwasher, media player, robot vacuum and lawn mower now use the new device card, with only the controls each device declares
- A dishwasher keeps its power control, a vacuum its stop, and a media player its shuffle and repeat, each only when the device declares it

### Fixed

- A dishwasher card shows the program's name, and keeps a long name inside the card

## [1.2.428] - 2026-11-12

### Changed

- Condition picker: an icon for the 'device fires' row

## [1.2.427] - 2026-11-12

### Changed

- The recording band sensors, the Customize source column and every schema device field pick through the device search: compatible devices only, the host's room suggested, a failed search says so
- The recording band sensors, the Customize source column and every schema device field pick through the device search: compatible devices only, the host's room suggested, a failed search says so. A recording band now offers only sensors carrying a cap the recorder listens to (contact, motion…): a bare sensor-typed device without one is no longer listed, since it could never start a recording
- The device card now draws covers (per role), lights, fans (with oscillation axes and presets) and switch heaters, all powered through switch

## [1.2.426] - 2026-11-11

### Changed

- Device cards and rows read the role: a switch with the heater role gets the timed run and heater card, a switch with the fan role is drawn as a fan; the thermostat and heater types are gone (climate roles label each climate device).
- The device card reads a climate device's kind and a heater from the device role, so a heater switch gets the plug card with its timed run and every climate role gets its own illustration.
- Generated hook for fan-control setOscillationAxis.

## [1.2.425] - 2026-11-11

### Added

- The automation row picker offers a 'Time is' condition with its own icon.
- Condition picker: the "Started by" condition has its icon

### Changed

- The device hero card can leave out its own name when the page around it already shows it
- The device hero card and the plug and climate device card can leave out their own name when the page around them already shows it

## [1.2.424] - 2026-11-11

### Changed

- A discovered select can be a multi-select (discoverOptions.multiple): the found candidates are ticked, never typed.
- Device card: one shared card (shell, parts, scenes) draws plugs and climate devices; the old switch and thermostat heroes are removed and the list tile is now DeviceSummaryCard
- Climate card: a heat/cool band is set with two handles on the dial, a radiator valve shows its opening (also when the device only reports a valve), side swing has its own toggle, unknown reachability is no longer shown as online, and a failed command says why on the card
- Every climate card role has its ambient scene: a warm or cool wash, the floor serpentine, the radiator and the heater drawn at the bottom, slower motion in standby

## [1.2.423] - 2026-11-11

### Changed

- New ConditionKindPicker: a searchable modal that lists the automation row kinds by category, with icon, description, example and event/state badge.

## [1.2.422] - 2026-11-11

### Changed

- Removed the unused DiscoveryPanel composite (adoption goes through the integration adoption modal).

## [1.2.421] - 2026-11-11

### Changed

- NodePicker and node-select fields can require a capability: a node the registry answered has no provider is listed disabled with the reason

## [1.2.420] - 2026-11-11

### Changed

- The device hero card (HeroModelCard, ModelHero) is now a library component with host-supplied labels, and the idle backdrop no longer runs behind a scene's command controls
- Every dropdown (Select) now opens a CamStack list with the same keyboard and screen-reader behaviour as the browser's, above any dialog it sits in, instead of the browser's own popup

## [1.2.419] - 2026-11-10

### Added

- Device pickers in schema forms (device-select / device-multiselect) are now the new DeviceValuePicker: compatible devices only with live readings, text search, filters and a second level for devices with several values

### Changed

- Generated system hooks include the new deviceManager.search query
- Generated hooks for the cluster-update capability
- An illustrated hero (washer, dryer, fountain…) no longer shows a second animated drum or ring poking out beside its illustration.
- Device rows and the container hero follow the child a container declares as its primary
- Device names and room suggestions follow the child a container declares as its primary
- The device hero card gains a utility section (history, consumables, power source) and puts the on/off and the cover, valve, lock, vacuum and media commands in the scene itself

## [1.2.418] - 2026-11-10

### Added

- The device-template field takes the device the text is written for: inserting that device's value writes the copyable camera alias, and the check and preview run against it.

## [1.2.417] - 2026-11-10

### Changed

- DeviceTemplateField asks the hub about every {{ … }} except {{ vars.x }}, as an action run does; heldSlots="placeholders" also holds a bare {{name}} for notification texts
- Pet feeder: while a feed runs, Cancel replaces Feed on the device row and in the feeder card.

## [1.2.416] - 2026-11-10

### Changed

- New DeviceTemplateField: a text field whose device references show as chips, with an insert-value picker that offers only the fields that fit and a hub check under the field; ExpressionInput moves here from the admin UI

## [1.2.415] - 2026-11-10

### Changed

- Notification sequence hooks removed (the notification centre runs Actions)

## [1.2.414] - 2026-11-09

### Changed

- A heat pump keeps its own name and is the suggested device; a climate circuit is not treated as its primary child

## [1.2.413] - 2026-11-09

### Added

- Device-manager hooks for rendering and checking device templates
- The device list shows Run or Stop for a timed run, and the time left while one is armed.

## [1.2.412] - 2026-11-09

### Changed

- New HeroScene, HeroCardA and DeviceRow components draw the layout-A device hero and the shared device row with one animated scene per device type
- Hero card layout A: one-line title row, full-width illustrated scene with animated washer, dryer, dishwasher, fountain and feeder art, label/value/action rows with progress bar and segmented controls
- TrpcClientProvider and useTrpcClient: history and device hooks read the tRPC client without a System, so a module can mount in a WebView
- Hero scene: side tiles no longer truncate, the caption splits state from detail, and the centre can follow the scene tone
- Hero scene: tiles never wrap, raised tile and row backing, larger muted fan blades
- Device hero scenes: drawn art for vacuum, mower, TV, speaker, light, blinds, lock, alarm, siren, contact, presence, weather, plug, button, update, control, events, gateway and script devices
- A heat pump device shows a compressor scene

## [1.2.411] - 2026-11-09

### Changed

- A generated integrations.delete hook is available again.

### Removed

- useAddonSettingsGetIntegrationFormSchema is removed; use useIntegrationInstancesInstanceFormSchema

## [1.2.410] - 2026-11-09

### Changed

- The account sign-in field no longer polls a claim action; it shows a paste hint under the sign-in button.

## [1.2.409] - 2026-11-08

### Changed

- Regenerated hooks: integrations.create removed, createInstance takes an addon-only seed field

## [1.2.408] - 2026-11-08

### Changed

- DataTable cells use tighter padding on a phone so a four-column table fits a 390px screen.

## [1.2.407] - 2026-11-08

### Changed

- Generated system hooks gain the heroLayout row-models read

## [1.2.406] - 2026-11-08

### Changed

- The Remote button shows a remote-control icon.

## [1.2.405] - 2026-11-08

### Changed

- Generated hooks include the new hero-layout capability (no visible change yet)
- Regenerated device-state hooks include the device-transitions capability

## [1.2.404] - 2026-11-08

### Changed

- A field's condition can now depend on a field in another section and resolves that field's default when it has no value yet.
- A settings form no longer draws the bare header of a section whose fields are all hidden by their condition.

## [1.2.403] - 2026-11-08

### Changed

- The media player card no longer shows an 'assumed' label.

## [1.2.402] - 2026-11-08

### Changed

- Timed run: while running, Stop · time left · Restart replace the start button.

## [1.2.401] - 2026-11-08

### Changed

- The generated addon-settings hooks for the deleted global and integration settings calls are removed.
- Generated hooks for the device alias setter

## [1.2.400] - 2026-11-07

### Changed

- The heater row's quick-run button shows the device's configured duration

## [1.2.399] - 2026-11-07

### Changed

- The scoped settings form no longer shows the previous target's values after its node, scope or addon changes: it starts empty and says "not available" when the new target answers nothing
- AddonScopedSettingsForm takes an optional unavailableText shown when the addon answers nothing.

## [1.2.398] - 2026-11-07

### Changed

- The device-to-value picker now reaches the editable fields of an existing source in the change dialog even when the device resolves after the dialog opens
- The device-to-value picker shows a chosen source as one compact card at every width (source row with Change, editable transform, proposal, preview); on a phone, picking is one device list that opens the fitting values inline; DevicePicker gains renderExpanded

## [1.2.397] - 2026-11-07

### Changed

- Terminals are now instances on the Terminal page: the list is kept as records, migrated in place with the same ids and cameras

## [1.2.396] - 2026-11-07

### Changed

- Generated hooks for the new scoped addon settings calls.
- System settings forms read and write one capability's scope: AddonScopedSettingsForm replaces AddonGlobalSettingsForm

## [1.2.395] - 2026-11-07

### Changed

- Target pickers and the device export panel read notification targets from the instances of notification-output; useInstancesOfCap is exported
- useInstancesOfCap and LinkableInstance are exported, and a linkable instance carries its switch and form values.
- The mesh connection-test hook is removed with the capability method
- The generated storage hooks drop the retired location write and test calls
- The generated system hooks drop the removed oidc-connections capability

## [1.2.394] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.393] - 2026-11-06

### Changed

- Removed the generated useMqttBrokerTestConnection hook.
- Regenerated cap vocabulary without the connection-test capability
- One device-to-value picker (DeviceValueField) lists only devices and values that fit, in three steps on a phone, with a token-chip adapter
- DeviceValueField opens the preview step on a phone only once there is a value to preview
- The device value picker waits for the device state before judging which values fit, and shows loading or failed instead of no value

## [1.2.392] - 2026-11-06

### Changed

- Pet fountain card: the Water drunk grid and the Clear daily count button are removed
- The instance picker slot receives disabled and required, so an optional link keeps an empty choice
- Removed the broker-select field type; every broker link is now an instance-select field on the one link primitive
- Device control cards roll a slider or switch back when the device refuses the change, and keep the new value while a slow device is still answering
- The media-player card shows title, artist and album, artwork, source and a progress bar whenever the device reports them, plus shuffle and repeat it can only read
- A refused device command now shows the reason and puts the control back; an unanswered command stops pinning its value after 30 seconds

## [1.2.391] - 2026-11-06

### Changed

- Dialogs can fill the whole page with width="full".

## [1.2.390] - 2026-11-06

### Changed

- The instance picker shows the field's own wording for its empty choice (noneLabel)
- The plain instance select is exported (InstancePlainSelect) for hosts that mount their own instance picker

## [1.2.389] - 2026-11-06

### Changed

- Settings forms draw an instance picker for fields that link to an instance of any function (instance-select)

## [1.2.388] - 2026-11-06

### Changed

- Broker pickers now list brokers from the one instance model
- Generated broker hooks follow the bus-only broker capability
- Broker pickers offer only brokers that are on, configured and working, and keep the chosen one visible with its state.
- Generated capability hooks include pipelineAnalytics.getMediaLocationCensus

## [1.2.387] - 2026-11-05

### Changed
- Choosing a primary child on a container whose children carry a source id (ESPHome) now sticks: the picked child is shown and used. Every dropdown in the library is now the shared Select.
- A confirmed device delete now shows the row as Removing… with its actions disabled until the hub has finished, then drops it; a failure restores the row with the error

## [1.2.386] - 2026-11-05

### Changed

- PageShell exposes PageHeaderActions so a page body can place its Add button in the page header

## [1.2.385] - 2026-11-05

### Removed

- The generated client no longer offers the retired per-integration settings methods

## [1.2.384] - 2026-11-05

### Changed

- Device History tab lists an appliance's runs (start, end, duration, energy, peak and average power, outcome) and shades each run on the power chart

## [1.2.383] - 2026-11-04

### Changed

- The single-instance device-export panel is exported, and the export setup block can be narrowed to one instance.

## [1.2.382] - 2026-11-04

### Changed

- The generated hooks include the hub operation that clears an integration's legacy settings

## [1.2.381] - 2026-11-04

### Changed

- The device export panel shows each export instance on its own (one section per Home Assistant broker), writes to the instance you act on, and reads a disabled instance as disabled

## [1.2.380] - 2026-11-04

### Changed

- The export panel names the export instance in every expose and unexpose call

## [1.2.379] - 2026-11-03

### Changed

- LogStream can offer an Origin filter (all / viewer app)
- Select keeps its themed background and text colour whatever a caller passes, and native option lists follow the theme, so dropdown options are readable in dark mode

## [1.2.378] - 2026-11-03

### Changed

- Generated hooks for the new running-threshold proposal method

## [1.2.377] - 2026-11-03

### Changed

- Media-player hero card rewritten: power, running state, power-meter watts and every declared control, unknown shown as unknown; artwork with cross-fade; a declared volume or mute always shows (unknown level) instead of hiding
- A wireless link badge with no signal reading shows no percentage (it showed NaN%)
- Media-player hero: a status with no state draws an unknown orb and unknown running, never on or Not running
- A Power line under every device's hero card shows watts and energy; heater and appliance cards no longer draw watts themselves
- The media-player hero no longer draws its own running line and watts; the device page's running line and Power line show them

## [1.2.376] - 2026-11-03

### Changed

- Generated hooks include the media-player power and step methods
- Media-player hero shows only what the device reports: no fake 0% volume, no empty now-playing, and an assumed state is marked as assumed
- A closed mobile drawer or bottom sheet mounts nothing, so no off-screen layer blurs the top bar on iPhone; the app shell top bar is opaque

## [1.2.375] - 2026-11-02

### Changed

- Regenerated capability hooks for the new board-key-source capability.
- The pet fountain panel shows the pump cycle section only when the device has the pump-cycle capability

## [1.2.374] - 2026-11-02

### Changed

- A select that discovers its options can be an optional picker ('Default' choice, 'missing' label for a gone value); the device export table's Type filter is searchable like Role and Integration.
- A searchable select no longer throws after it closes on a page that was just left.

## [1.2.373] - 2026-11-02

### Changed

- Device export table: selectors on the left with the search on the right, searchable Role and Integration filters showing display names, a bulk bar with select all / none, and a multi export that now lands every selected device

## [1.2.372] - 2026-11-02

### Changed

- Typed hooks for the integration-instances capability

## [1.2.371] - 2026-11-02

### Changed

- New useSystemDebugWatch hook.

## [1.2.370] - 2026-11-02

### Changed

- Exports uiLibraryVersion so the admin UI can tell which library a page was built against.
- A registered keyboard shortcut can carry a label, and useRegisteredHotkeys lists the shortcuts currently registered.

## [1.2.369] - 2026-11-01

### Changed

- Generated hooks for the fan presets capability.
- A heater has its own card with a heat glow, and a heater or pet fountain shows a run-for-N timer with a countdown.

## [1.2.368] - 2026-11-01

### Changed

- Mobile drawer: the closed drawer no longer leaves a full-screen backdrop layer over the top bar (it blurred and dimmed the header on an installed iPhone app).
- Removed the generated hooks for the workspace-install methods of the addons capability.
- Washers and dryers get an appliance card (running state, dwell, live power); the pet fountain shows a ripple while the pump runs

## [1.2.367] - 2026-11-01

### Changed

- Generated hooks include userManagement.getAdminBootstrapStatus

## [1.2.366] - 2026-11-01

### Changed

- The mobile navigation drawer no longer blurs the screen behind it, so the status bar stays sharp while it is open

## [1.2.365] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.364] - 2026-10-31

### Added

- A device can be powered by a smart switch linked in Customize, with manual power on, power off and force restart (switch off, wait, switch on).

## [1.2.363] - 2026-10-31

### Changed

- Generated system hooks no longer survive in every addon page bundle when unused, so a new hook stops changing every page addon's built output
- TimelineSlider: a 24 h track with draggable, keyboard-movable markers and hold bands
- Added Textarea, Slider, Radio and FileInput primitives and a Button 'unstyled' variant, so pages stop using the browser's form controls
- Select accepts option children and a wrapperClassName, for grouped, computed or inline selects

## [1.2.362] - 2026-10-31

### Changed

- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.361] - 2026-10-31

### Changed

- The lock hero card shows the door-open state.
- The lock card shows the linked door contact (open, closed or unknown) with its name, and Lock is disabled with a reason while the door is open

## [1.2.360] - 2026-10-31

### Changed

- A notification target's discovered device list (Home Assistant notify service, Echo) is now a searchable picker instead of a native select
- Generated hooks for the schedulers capability

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
