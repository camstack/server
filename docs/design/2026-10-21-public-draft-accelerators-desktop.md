# Public-docs draft: a Coral Edge TPU with the desktop app (agent role)

Status: DRAFT for the public docs (`camstack/docs`). States what is possible
per OS on 2026-10-21 and what is not wired yet, so the public page does not
promise more than the code does.

The desktop app stages its own portable Python under `<dataDir>/deps/python`
(`packages/types/src/deps/python-downloader.ts`) and installs the
`edgetpu` pip requirements (`ai-edge-litert`) when the probe reports a Coral.
Updated 2026-10-22: the same install now stages the libedgetpu delegate under
`<dataDir>/deps/edgetpu/lib/` (pinned, SHA-256 verified,
`packages/types/src/deps/edgetpu-delegate.ts`), and the pool and the probe find
it there without `CAMSTACK_EDGETPU_LIB`.

| OS | Coral USB | Coral PCIe / M.2 | Notes |
| --- | --- | --- | --- |
| Linux | yes | yes | Probe reads `/sys` (USB ids, `/sys/class/apex`, `/dev/apex_N`). Delegate + libusb are downloaded automatically (feranick `ubuntu24.04` build: glibc 2.38 or newer, i.e. Ubuntu 24.04+ / Debian 13+). PCIe needs the host gasket/apex driver (see the Docker draft) and `/dev/apex_N` readable/writable by the desktop user (`apex` group). An older distro: install a delegate yourself and point `CAMSTACK_EDGETPU_LIB` at it. |
| macOS, Apple Silicon | yes, once provisioned | no (no apex driver for macOS) | The delegate (`MacOS_Silicon` zip, libusb linked in, no Homebrew) is downloaded when the edgetpu runtime is provisioned. There is no `/sys` on macOS, so the probe sees the Coral only through the staged delegate (one unit assumed): the FIRST provisioning does not start on its own yet. |
| macOS, Intel | no | no | ai-edge-litert 2.1.6 has no macOS x86_64 wheel, and the Intel delegate links MacPorts libusb. Refused by name. |
| Windows | no | no | No libedgetpu build for TF 2.17.1 exists for Windows (feranick ships Linux and macOS only), and the old Google Windows delegate is built for an older TFLite that ai-edge-litert 2.1.6 cannot use. Refused by name. |

## Not wired yet (follow-ups)

- macOS: a USB Coral is not enumerated (no `/sys`; `ioreg` is not read), so
  nothing triggers the first delegate download there, and several USB units
  read as one.

## Expected speed

Measured Coral PCIe step latencies (and the comparison with a Zen4 CPU on
OpenVINO) are in the Docker draft's table; the desktop app runs the same
Python pool, so a Linux desktop with the same Coral sees the same numbers.
