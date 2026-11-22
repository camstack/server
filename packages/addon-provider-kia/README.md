# Kia Connect Provider

Kia Connect (Kia UVO / Hyundai Bluelink) vehicle device-provider addon for CamStack: reads the car (odometer, range, fuel, locks, doors, tyre warnings, position) and locks, unlocks and pre-conditions it through the maker cloud, in a bundled Python worker.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-kia` on npm.

## What it provides

- **Kia Connect** (`provider-kia`): Adopt a Kia (or Hyundai / Genesis) connected car: state, position, service distance, lock and climate through the maker cloud. Category: providers.
  - Capabilities: `device-provider`, `integration-instances`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Kia Connect account: Username, Password, Security PIN
- Cloud: Region, Brand

## Requirements

- Placement: hub-only.
- Python: Kia Connect installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## Limits and command semantics

- **Daily allowance.** The Kia cloud allows about 200 calls a day. The addon counts them (sign-in 1, read 1, forced wake-up 3, command 8) and keeps 60 for the scheduled reads. When the day is spent the account stays connected and shows when it resumes (UTC midnight); a command or wake-up is refused with that time.
- **A command that times out may still have run.** A lock, unlock or climate command waits up to 75 s for the car. If the worker does not answer in that time the call fails with a timeout and the worker is restarted, but the car may well have executed the command: the cloud relays it asynchronously. Nothing is assumed either way. The lock and climate state shown is only what the car reports at the next read, so check it before sending the command again.
- **Testing the connection** is a real sign-in: at most one per minute per account, and credentials the cloud already refused are not tried again.
- **No one-time-code accounts.** An account that asks for a code at sign-in cannot be connected.
