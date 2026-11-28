# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-28

### Changed

- Renamed to Dominevo: the package is now published as @dominevo/addon-provider-reolink, restarting at version 0.1.0.

## [1.2.264] - 2026-11-26

### Changed

- Rebuilt against updated dependencies.

## [1.2.263] - 2026-11-25

### Changed

- A stream that stalls because one packet never arrived is now logged with the missing packet and how long media was withheld

## [1.2.262] - 2026-11-25

### Changed

- Reolink: an awake camera that drops its connection (D2C_DISC) is redialled after a short capped backoff instead of a long wait, so recording resumes sooner.

## [1.2.261] - 2026-11-24

### Changed

- Battery camera keep-awake now logs sampled wakes, an hourly wake summary, session re-logins with their reason, and wake failures while video still flows
- Battery cameras no longer run the hourly refresh or the wake warm-up while a stream is open, and concurrent source-refresh requests share one run, so video pauses are shorter.
- Battery keep-awake skips its wake while video is flowing, so it no longer pauses the stream
- Reolink battery cameras: a login the camera abandons no longer blocks the camera, standalone battery sessions re-dial before the camera's 30 min cut, and a silent stream gets a fresh server.
- A battery camera's stream catalog, including the first one served after a restart, now carries the camera's current features instead of the stored list, so the hub no longer keeps it awake.
- A Reolink probe that only half-answers (a lossy link) no longer deletes and re-creates the camera's Siren, Floodlight or PIR devices under new ids.
- A battery camera switched to wired power is no longer marked asleep by the background sleep check, which used to close its live and recording streams.
- Reolink streams self-heal with nodelink-js 0.13.2: a silent wired camera recovers in place, a sleeping battery camera is not re-woken by the recovery.
- A battery camera's scheduled-refresh stamp and attempt count now survive a restart and later battery reads, so a restart no longer wakes a camera the window already served or gave up on.
- A scheduled refresh of a battery camera no longer wakes it for the email-config read when it fell asleep mid-refresh, and every proactive wake now logs which action asked for it.
- A battery camera that is asleep is no longer woken by its siren, floodlight or PIR accessory when the addon restarts: they serve their saved state and refresh on the next wake.

### Fixed

- A Reolink camera that drops and reconnects repeatedly no longer crashes the Reolink provider (and wakes every battery camera).
- A wired camera, or a battery camera on its adapter, recovers a stalled stream in place within seconds; a sleeping battery camera is never woken by a recovery
- A powered camera or hub reopens a dead Baichuan session on its own (the recurring ~30-minute recording holes); a battery camera is never woken to do it.

## [1.2.260] - 2026-11-23

### Changed

- A battery camera that answers with an all-zero placeholder no longer reports 0% and raises a false empty-battery alert
- Adding a Reolink camera can now be set to Local only (direct to the camera IP, never the Reolink relay), and changing the connection mode or UDP discovery method of an existing camera takes effect at once.

### Fixed

- Changing how a camera connects (transport, UID, UDP discovery) while it is still logging in no longer keeps the old attempt alive: the camera dials again with the new settings.

## [1.2.259] - 2026-11-21

### Changed

- Battery cameras without a PIR sensor no longer get a PIR switch, and a battery camera re-reads its accessories on a wake at most every 6 hours so a wrongly created accessory is removed without restarting the provider.

## [1.2.258] - 2026-11-21

### Changed

- A battery camera's ghost Floodlight child is now retired once a probe confirms it has no floodlight, floodlight and siren commands are refused on a camera without them, and a PIR write the camera answers with 400 is retried with only the fields it reports.

## [1.2.257] - 2026-11-21

### Changed

- Battery cameras whose web server is off no longer offer an FLV stream in the stream selection

## [1.2.256] - 2026-11-21

### Fixed

- The hourly battery refresh no longer retries every 10 minutes when only the snapshot was stale; the window is stamped and the stale snapshot logged

## [1.2.255] - 2026-11-20

### Changed

- The Power source setting no longer offers an empty choice.
- Battery cameras are kept awake while a live or recorded stream is attached, so continuous recording is no longer cut by the camera's standby.
- A battery camera that is streaming is no longer shown as sleeping because of a hub or sleep-push claim, and a camera on a wired power source ignores those claims; a Home Hub child is re-dialed cleanly just before the hub's 28-minute session cut
- A newly added Reolink camera now sets up its own local event push once (HaCfg webhook for standalone battery cameras, else the camera mailbox), controlled by the new Auto-configure event push on add option (on by default); the outcome is logged and a failure never blocks the add

## [1.2.254] - 2026-11-20

### Changed

- The default Reolink integration offers only the camera mailbox (no connection fields, no Test); the camera mailbox link no longer appears on NVR / Home Hub integrations

### Fixed

- Turning PIR on or off on a sleeping battery camera now wakes it first instead of failing with a 400; the power source (wired or battery) is now an ordinary setting in its own section of the Advanced tab instead of buttons.
- A standalone camera that uses the camera mailbox now links the default Reolink integration to it, so the mailbox no longer looks unused
- The camera SMTP password on the Email tab is kept per camera as a secret, and the field shows whether one is set

## [1.2.253] - 2026-11-20

### Fixed

- Power-source button labels show translated text instead of their keys.

## [1.2.252] - 2026-11-20

### Changed

- Battery cameras get a Power source section: read whether the camera runs on the adapter or the battery, and switch between wired and battery power (dry-run first, read back after; only switch to wired power when the adapter meets the camera's spec).

### Fixed

- Power-source button labels show translated text instead of their keys.

## [1.2.251] - 2026-11-20

### Fixed

- Reverted the 'sleep push ignored while streaming' change: a camera that really slept kept a dead stream open and live view could not start.

## [1.2.250] - 2026-11-20

### Changed

- A Reolink battery camera that is being recorded or watched now stays awake: a firmware sleep notification no longer cuts its live stream while a consumer is attached

## [1.2.249] - 2026-11-20

### Changed

- Battery cameras report the charge state (charging, full, idle), battery voltage in volts, current and temperature when the firmware sends them

## [1.2.248] - 2026-11-19

### Changed

- Siren and floodlight no longer hand-set the motion-trigger feature; it follows the bound cap

## [1.2.247] - 2026-11-19

### Fixed

- The Reolink addon no longer floods the hub with integration lookups that slowed the whole system and restarted the addon every few minutes

## [1.2.246] - 2026-11-19

### Changed

- The NVR / Home Hub sleep-state reconcile of its cameras is now scheduled by the core instead of a timer in the session; it still reads only the NVR and never wakes a camera.

## [1.2.245] - 2026-11-18

### Changed

- Add device inside a Reolink integration scans the network only for the default integration; an NVR or Home Hub integration adopts its own cameras

## [1.2.244] - 2026-11-17

### Changed

- The battery camera now wakes through its low-power-sleep capability, so it is the one recognised as sleeping

### Fixed

- A camera whose probe found a battery now also registers its sleep and wake support, so it is woken before streaming

## [1.2.243] - 2026-11-17

### Added

- The siren can be sounded a chosen number of times; the count goes to the camera as asked
- Cameras also declare their MAC, serial, UID and IP as device identifiers (the hardware metadata is unchanged); a network read that fails keeps the MAC and IP declared before.
- A network read that answers without a MAC or IP no longer erases the stored one; hub and NVR children no longer declare the hub's MAC or IP as their own identity

### Changed

- An NVR / Home Hub integration has a Test button: it logs in once and says whether the username or password was refused or the hub did not answer, with the channel count on success.
- A clip on a sleeping battery camera's SD card now plays or downloads when you ask for it: the camera is woken, waited for up to 15 s, and a camera that does not come up is refused as wake-timeout instead of sleeping.

## [1.2.242] - 2026-11-16

### Changed

- Siren: timed trigger with a countdown; plays are converted to seconds using a per-camera seconds-per-play setting
- Siren default is now labelled as a number of plays (it always was); the stored setting is unchanged

## [1.2.241] - 2026-11-14

### Changed

- A stored hub device is no longer turned into an integration on restore. Integrations already marked migratedFromHubDeviceId stay hub integrations.

## [1.2.240] - 2026-11-12

### Changed

- A new Reolink hub is named "Reolink" plus its model (Home Hub when none was read).

## [1.2.239] - 2026-11-11

### Fixed

- A battery camera's own 0% read during a wake refresh, asleep, or on its adapter or panel no longer replaces the real level (no more false low-battery notifications)

## [1.2.238] - 2026-11-11

### Changed

- A battery camera asleep or on its adapter no longer reports a 0% level from the hub, which raised low/normal battery notification pairs; the last real level is kept.

## [1.2.237] - 2026-11-11

### Changed

- A Reolink Home Hub that returns an empty channel list no longer flags sleeping battery cameras offline; the missing-from-list grace now starts at boot and sleeping cameras are never marked offline
- An empty channel list from a Reolink hub with adopted cameras is now treated as unknown (indefinitely), and a missing sleeping camera goes offline only after 6 h

## [1.2.236] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [1.2.235] - 2026-11-08

### Changed

- Settings migration creates the instance through the single create door

## [1.2.234] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.233] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.232] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [1.2.231] - 2026-11-06

### Changed

- A Reolink integration whose cameras mail the camera mailbox now links to it, so deleting the mailbox while it is in use is refused and the link shows in the instance model
- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [1.2.230] - 2026-11-06

### Changed

- The email-push mailbox is created and read through the SMTP addon's instances

## [1.2.229] - 2026-11-05

### Changed

- A Reolink Home Hub / NVR integration no longer offers the manual Enter parameters add in Add device

## [1.2.228] - 2026-11-05

### Fixed

- A deleted camera stops its timers at once instead of polling until the worker restarts

## [1.2.227] - 2026-11-05

### Changed

- Reolink clip catalog refresh default is declared on the fleet-default hook; the form and stored value are unchanged.
- A camera adopted under an NVR / Home Hub now shows its hub and channel in settings, no longer lets you edit its address or credentials (they belong to the integration), and hides the hub-wide ports and time sections.

## [1.2.226] - 2026-11-05

### Changed

- Cameras whose host reports an unknown time zone (Etc/Unknown) no longer fail the clip catalog refresh; it falls back to the camera's offset or UTC.

## [1.2.225] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.224] - 2026-11-04

### Changed

- Reolink starts again after the update: its integration migrations are offered in order, so the move of the connection settings runs

## [1.2.223] - 2026-11-04

### Changed

- Reolink integrations keep their connection (host, ports, username, transport, password) as one typed record each, moved from the old settings by a boot migration; each integration keeps its own values and password

## [1.2.222] - 2026-11-04

### Changed

- Cameras that named no integration are claimed to the default Reolink integration

## [1.2.221] - 2026-11-03

### Changed

- Compile against the switch status where a never-reported state reads as unknown

## [1.2.220] - 2026-11-02

### Changed

- Battery-camera motion push (HaCfg webhook) is now received on the addon's own HTTP endpoint at the hub's internal address (System → Network) instead of a separate port 9081; cameras already using it are re-pointed automatically the next time they connect, and the old webhook settings are removed

## [1.2.219] - 2026-11-02

### Changed

- Battery cameras now mail motion to the camera mailbox of the Email (SMTP) addon instead of a server inside Reolink; your cameras keep their port, address and credentials, and the mailbox appears under Brokers; Reolink starts and runs its cameras even when the Email (SMTP) addon is not installed, and creates the mailbox with your old credentials as soon as it is available

## [1.2.218] - 2026-11-02

### Changed

- New debug channel debug.reolink-events: event subscription state per camera, readable from Logs > Watch.

## [1.2.217] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.216] - 2026-10-31

### Changed

- The NVR / Home Hub can be added as a Gateway device (reboot, web interface link) next to its channel cameras.

## [1.2.215] - 2026-10-31

### Changed

- A Reolink NVR / Home Hub is now its own integration: add it from Integrations (its password is kept in the keychain), its channels are adopted as cameras, and an existing Hub device is migrated automatically on first start with its cameras and their settings kept.
- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.214] - 2026-10-30

### Changed

- Discovery scans every subnet the network scan covers; the network CIDR field in the scan options is gone

## [1.2.213] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.212] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.211] - 2026-10-27

### Added

- Reolink Provider: Reolink camera device provider addon for CamStack — native Baichuan protocol.
- Provides the addon Reolink.
