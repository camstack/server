"""The parts of the inference pool that differ between POSIX and Windows.

Everything here is a seam with ONE job: keep `inference_pool.py` free of
platform branches. On Linux/macOS each function delegates to the primitive the
pool always used (`fcntl.flock`, asyncio's pipe transports, `resource`); on
Windows it uses the closest equivalent that exists there. Nothing in this module
changes what Linux or macOS do — the Windows branches are only reachable when
`sys.platform == "win32"`, and each takes its platform as a parameter so a
POSIX machine can test both.

Why stdio is here too: the pool talks to its host over stdin/stdout, and
asyncio's `connect_read_pipe` / `connect_write_pipe` cannot adopt the child end
of a Node `child_process` pipe on Windows (the ProactorEventLoop needs an
overlapped handle; that end is a plain synchronous one). The Windows branch
reads stdin on a thread and writes stdout through an executor instead.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import os
import sys
from typing import Any, BinaryIO, Optional

_READ_CHUNK = 1 << 16


def is_windows(platform: Optional[str] = None) -> bool:
    return (platform if platform is not None else sys.platform) == "win32"


# ---------------------------------------------------------------------------
# Stack dump on demand (the poison probe)
# ---------------------------------------------------------------------------


def register_stack_dump_signal(
    platform: Optional[str] = None,
    faulthandler_mod: Any = None,
    signal_mod: Any = None,
    stream: Any = None,
) -> bool:
    """Dump every thread's Python stack to stderr on SIGUSR1.

    The host signals a worker it is about to kill for hanging (POISONED), so
    the line that says WHERE it hung — a libedgetpu call, a compile, the
    loop — lands in the host log (the host logs this process's stderr under
    the worker label) before SIGTERM. `faulthandler` writes from its C
    handler, so it answers even while a native call holds the GIL.
    POSIX only: Windows has no SIGUSR1, and there it registers nothing.
    """
    if is_windows(platform):
        return False
    if faulthandler_mod is None:
        import faulthandler as faulthandler_mod  # noqa: PLC0415
    if signal_mod is None:
        import signal as signal_mod  # noqa: PLC0415
    signum = getattr(signal_mod, "SIGUSR1", None)
    if signum is None:
        return False
    faulthandler_mod.register(
        signum, file=stream if stream is not None else sys.stderr, all_threads=True, chain=False
    )
    return True


# ---------------------------------------------------------------------------
# Advisory file lock (the per-model compile-cache lock)
# ---------------------------------------------------------------------------


def try_lock_exclusive(fd: int, platform: Optional[str] = None) -> bool:
    """Take a NON-BLOCKING exclusive lock on `fd`; False when someone holds it.

    POSIX: `flock(LOCK_EX | LOCK_NB)`. Windows: `msvcrt.locking(LK_NBLCK)` on the
    first byte — byte-range locks are the only advisory primitive the C runtime
    offers, and one byte is enough because the lock file is only ever a mutex.
    Raises OSError for "unusable lock", exactly as `flock` did, so the caller's
    "compile without the cache" path is unchanged.
    """
    if is_windows(platform):
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True
    import fcntl

    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def unlock(fd: int, platform: Optional[str] = None) -> None:
    if is_windows(platform):
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(fd, fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Own-process memory (mem_stats)
# ---------------------------------------------------------------------------


def read_windows_memory() -> dict:
    """Working set / peak working set / thread-less view of THIS process, in kB.

    `GetProcessMemoryInfo` (psapi). Partial or empty on any failure — this rides
    the mem_stats reply and must never raise.
    """
    out: dict = {}
    try:
        import ctypes
        from ctypes import wintypes

        class _Counters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = _Counters()
        counters.cb = ctypes.sizeof(_Counters)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        psapi = ctypes.WinDLL("psapi", use_last_error=True)  # type: ignore[attr-defined]
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(_Counters),
            wintypes.DWORD,
        ]
        if psapi.GetProcessMemoryInfo(
            kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb
        ):
            out["rssKb"] = int(counters.WorkingSetSize // 1024)
            out["hwmKb"] = int(counters.PeakWorkingSetSize // 1024)
            out["maxRssKb"] = int(counters.PeakWorkingSetSize // 1024)
            out["vmKb"] = int(counters.PagefileUsage // 1024)
    except Exception:
        pass
    return out


# ---------------------------------------------------------------------------
# stdin / stdout transport
# ---------------------------------------------------------------------------


class ThreadedStdoutWriter:
    """The slice of `asyncio.StreamWriter` the pool uses: `write` + `drain`.

    `write` only buffers; `drain` hands the buffer to ONE worker thread, which
    writes and flushes it, so a slow host stalls the awaiting coroutine and
    never the event loop. A single worker keeps bytes in the order written.
    """

    def __init__(self, out: BinaryIO, loop: asyncio.AbstractEventLoop) -> None:
        self._out = out
        self._loop = loop
        self._pending = bytearray()
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="pool-stdout"
        )

    def write(self, data: bytes) -> None:
        self._pending += data

    def _flush(self, data: bytes) -> None:
        self._out.write(data)
        self._out.flush()

    async def drain(self) -> None:
        if not self._pending:
            return
        data = bytes(self._pending)
        self._pending.clear()
        await self._loop.run_in_executor(self._executor, self._flush, data)


def _pump_stdin(
    fd: int, reader: asyncio.StreamReader, loop: asyncio.AbstractEventLoop
) -> None:
    """Thread body: stdin bytes -> the reader, EOF on close or error."""
    try:
        while True:
            chunk = os.read(fd, _READ_CHUNK)
            if not chunk:
                break
            loop.call_soon_threadsafe(reader.feed_data, chunk)
    except OSError:
        pass
    finally:
        try:
            loop.call_soon_threadsafe(reader.feed_eof)
        except RuntimeError:
            pass  # the loop is already closed — nothing is waiting


def open_threaded_stdio(
    loop: asyncio.AbstractEventLoop, in_fd: int, out: BinaryIO
) -> tuple[asyncio.StreamReader, Any]:
    import threading

    reader = asyncio.StreamReader(loop=loop)
    threading.Thread(
        target=_pump_stdin, args=(in_fd, reader, loop), name="pool-stdin", daemon=True
    ).start()
    return reader, ThreadedStdoutWriter(out, loop)


async def open_stdio(
    loop: asyncio.AbstractEventLoop, platform: Optional[str] = None
) -> tuple[asyncio.StreamReader, Any]:
    """(reader, writer) over this process's stdin/stdout, binary, on any OS."""
    if is_windows(platform):
        import msvcrt

        # Belt and braces: Python already opens the std handles binary, but a
        # CRLF translation on a length-prefixed protocol corrupts every frame.
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        return open_threaded_stdio(loop, sys.stdin.fileno(), sys.stdout.buffer)

    reader = asyncio.StreamReader(loop=loop)
    protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    transport, stdout_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout.buffer
    )
    return reader, asyncio.StreamWriter(transport, stdout_protocol, None, loop)
