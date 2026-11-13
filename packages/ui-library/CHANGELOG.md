# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
### Changed

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
