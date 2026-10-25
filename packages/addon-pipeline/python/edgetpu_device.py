"""Which Coral Edge TPU a pool's libedgetpu delegate opens.

The pool `device` comes from the TS side as an explicit ordinal — ``usb:0``,
``usb:1``, ``pci:0``, ``pci:1`` (``edgetpuDelegateDevice`` in
``@camstack/types``). libedgetpu's ``device`` option also takes the bare bus
(``usb`` / ``pci`` = the first unit of that bus). Pure: no libedgetpu import.
"""
from __future__ import annotations

import ctypes
import os
import re
from typing import Callable, Mapping, Optional

_DEVICE = re.compile(r"^(usb|pci)(:\d+)?$")

# No device selector at all: the library's own default (first Edge TPU found).
_LIBRARY_DEFAULT = ("", "default", "all")


def edgetpu_delegate_options(device: Optional[str]) -> Optional[dict[str, str]]:
    """The ``load_delegate`` options for ``device``, or ``None`` for the default.

    Raises ``ValueError`` on a string libedgetpu does not address, rather than
    silently opening whichever Edge TPU enumerates first.
    """
    dev = (device or "").strip()
    if dev in _LIBRARY_DEFAULT:
        return None
    if _DEVICE.match(dev) is None:
        raise ValueError(f"EdgeTPU: device '{dev}' is not usb[:N] or pci[:N]")
    return {"device": dev}


# Where the hub image's installer has always put the delegate.
LEGACY_EDGETPU_LIB = "/data/deps/edgetpu/lib/libedgetpu.so.1"


def edgetpu_library_path(
    env: "Mapping[str, str]",
    platform: str,
    exists: Optional[Callable[[str], bool]] = None,
) -> str:
    """The libedgetpu file this pool loads.

    The same lookup as the TS probe (``chooseEdgetpuDelegate`` in
    ``@camstack/types`` ``deps/edgetpu-delegate.ts``): ``CAMSTACK_EDGETPU_LIB``
    when set (followed even if missing — ``load_delegate`` then names it); the
    copy the deps downloader staged under ``<CAMSTACK_DATA>/deps/edgetpu/lib/``
    (``libedgetpu.1.dylib`` on macOS, ``libedgetpu.so.1`` elsewhere); else the
    hub's historical path, which on the hub image is the same file.
    """
    check = exists or os.path.exists
    override = (env.get("CAMSTACK_EDGETPU_LIB") or "").strip()
    if override:
        return override
    data_root = env.get("CAMSTACK_DATA") or env.get("CAMSTACK_DATA_DIR") or ""
    if data_root:
        name = "libedgetpu.1.dylib" if platform == "darwin" else "libedgetpu.so.1"
        staged = os.path.join(data_root, "deps", "edgetpu", "lib", name)
        if check(staged):
            return staged
    return LEGACY_EDGETPU_LIB


# The libedgetpu "std" delegate links libusb even when it drives a PCIe Coral.
# The installer (edgetpu-install.sh) drops this copy beside the delegate for an
# image that lacks the system package.
_LIBUSB_SONAME = "libusb-1.0.so.0"


def _load_global(path: str) -> object:
    return ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)


def preload_libusb(
    lib_dir: str, loader: Optional[Callable[[str], object]] = None
) -> Optional[str]:
    """Load ``<lib_dir>/libusb-1.0.so.0`` RTLD_GLOBAL, when that copy exists.

    Done before ``load_delegate`` so the delegate's own dlopen of libusb
    resolves to it with no ``LD_LIBRARY_PATH``. Returns the path loaded, or
    ``None`` when there is no copy (the system library is then the only one).
    A copy that exists but fails to load raises ``OSError`` to the caller.
    """
    path = os.path.join(lib_dir, _LIBUSB_SONAME)
    if not os.path.exists(path):
        return None
    (loader or _load_global)(path)
    return path
