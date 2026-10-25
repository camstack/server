"""The POSIX/Windows seams of the inference pool (`pool_platform.py`).

Both branches are exercised on whatever machine runs this: the Windows branch
takes its platform as a parameter and a fake `msvcrt` module, so a Mac or a
Linux box proves the dispatch, the byte-range lock calls and the threaded
stdin/stdout transport. What it cannot prove is that `msvcrt.locking` and
psapi behave as modelled on real Windows — that is the one thing still waiting
for a Windows host.

Run: python3 -m unittest test_pool_platform -v
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

import pool_platform


class FakeMsvcrt(types.ModuleType):
    LK_NBLCK = 2
    LK_UNLCK = 0
    O_BINARY = 0x8000

    def __init__(self, busy: bool = False) -> None:
        super().__init__("msvcrt")
        self.busy = busy
        self.calls: list[tuple[int, int, int]] = []
        self.modes: list[tuple[int, int]] = []

    def locking(self, fd: int, mode: int, nbytes: int) -> None:
        self.calls.append((fd, mode, nbytes))
        if self.busy and mode == self.LK_NBLCK:
            raise OSError(13, "Permission denied")

    def setmode(self, fd: int, flags: int) -> int:
        self.modes.append((fd, flags))
        return 0


class IsWindowsTest(unittest.TestCase):
    def test_follows_the_explicit_platform_then_sys_platform(self) -> None:
        self.assertTrue(pool_platform.is_windows("win32"))
        self.assertFalse(pool_platform.is_windows("linux"))
        self.assertFalse(pool_platform.is_windows("darwin"))
        with mock.patch.object(sys, "platform", "win32"):
            self.assertTrue(pool_platform.is_windows())


@unittest.skipIf(sys.platform == "win32", "flock is the POSIX branch")
class PosixLockTest(unittest.TestCase):
    def test_second_holder_is_refused_until_the_first_unlocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.lock")
            with open(path, "a+") as first, open(path, "a+") as second:
                self.assertTrue(pool_platform.try_lock_exclusive(first.fileno()))
                self.assertFalse(pool_platform.try_lock_exclusive(second.fileno()))
                pool_platform.unlock(first.fileno())
                self.assertTrue(pool_platform.try_lock_exclusive(second.fileno()))
                pool_platform.unlock(second.fileno())


class WindowsLockTest(unittest.TestCase):
    def test_takes_a_one_byte_non_blocking_range_lock(self) -> None:
        fake = FakeMsvcrt()
        with tempfile.TemporaryFile() as handle, mock.patch.dict(sys.modules, {"msvcrt": fake}):
            self.assertTrue(pool_platform.try_lock_exclusive(handle.fileno(), "win32"))
            pool_platform.unlock(handle.fileno(), "win32")
        self.assertEqual([c[1:] for c in fake.calls], [(2, 1), (0, 1)])

    def test_a_held_lock_is_false_not_an_exception(self) -> None:
        fake = FakeMsvcrt(busy=True)
        with tempfile.TemporaryFile() as handle, mock.patch.dict(sys.modules, {"msvcrt": fake}):
            self.assertFalse(pool_platform.try_lock_exclusive(handle.fileno(), "win32"))


class ThreadedStdioTest(unittest.IsolatedAsyncioTestCase):
    async def test_reader_gets_the_bytes_then_eof(self) -> None:
        loop = asyncio.get_running_loop()
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        with os.fdopen(out_write, "wb") as out_file:
            reader, writer = pool_platform.open_threaded_stdio(loop, in_read, out_file)
            os.write(in_write, b"hello ")
            os.write(in_write, b"world")
            self.assertEqual(await asyncio.wait_for(reader.readexactly(11), 5), b"hello world")
            os.close(in_write)
            self.assertEqual(await asyncio.wait_for(reader.read(), 5), b"")
            self.assertTrue(reader.at_eof())

            writer.write(b"abc")
            writer.write(b"def")
            await writer.drain()
            self.assertEqual(os.read(out_read, 6), b"abcdef")
        os.close(out_read)
        os.close(in_read)

    async def test_writes_keep_their_order_across_drains(self) -> None:
        loop = asyncio.get_running_loop()
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        with os.fdopen(out_write, "wb") as out_file:
            _, writer = pool_platform.open_threaded_stdio(loop, in_read, out_file)
            for chunk in (b"1", b"2", b"3"):
                writer.write(chunk)
                await writer.drain()
            self.assertEqual(os.read(out_read, 3), b"123")
        for fd in (in_write, in_read, out_read):
            os.close(fd)

    async def test_open_stdio_on_windows_sets_binary_mode_and_uses_the_threads(self) -> None:
        loop = asyncio.get_running_loop()
        fake = FakeMsvcrt()
        in_read, in_write = os.pipe()
        out_read, out_write = os.pipe()
        with os.fdopen(out_write, "wb") as out_file:
            fake_sys = types.SimpleNamespace(
                stdin=types.SimpleNamespace(fileno=lambda: in_read),
                stdout=types.SimpleNamespace(fileno=lambda: out_write, buffer=out_file),
            )
            with mock.patch.dict(sys.modules, {"msvcrt": fake}), mock.patch.object(
                pool_platform, "sys", fake_sys
            ), mock.patch.object(os, "O_BINARY", 0x8000, create=True):
                reader, writer = await pool_platform.open_stdio(loop, "win32")
            os.write(in_write, b"x")
            self.assertEqual(await asyncio.wait_for(reader.readexactly(1), 5), b"x")
            writer.write(b"y")
            await writer.drain()
            self.assertEqual(os.read(out_read, 1), b"y")
        self.assertEqual([m[0] for m in fake.modes], [in_read, out_write])
        for fd in (in_write, in_read, out_read):
            os.close(fd)



class StackDumpSignalTest(unittest.TestCase):
    """A hung worker is asked for its stack (SIGUSR1) before it is killed."""

    def test_posix_registers_faulthandler_on_sigusr1_to_stderr(self) -> None:
        calls = []
        fake_faulthandler = types.SimpleNamespace(
            register=lambda signum, file, all_threads, chain: calls.append(
                (signum, file, all_threads, chain)
            )
        )
        fake_signal = types.SimpleNamespace(SIGUSR1=10)
        stream = io.StringIO()
        registered = pool_platform.register_stack_dump_signal(
            platform="linux", faulthandler_mod=fake_faulthandler, signal_mod=fake_signal, stream=stream
        )
        self.assertTrue(registered)
        self.assertEqual(calls, [(10, stream, True, False)])

    def test_windows_has_no_sigusr1_and_registers_nothing(self) -> None:
        calls = []
        fake_faulthandler = types.SimpleNamespace(register=lambda *a, **k: calls.append(a))
        registered = pool_platform.register_stack_dump_signal(
            platform="win32",
            faulthandler_mod=fake_faulthandler,
            signal_mod=types.SimpleNamespace(),
            stream=io.StringIO(),
        )
        self.assertFalse(registered)
        self.assertEqual(calls, [])

    def test_real_registration_dumps_this_thread_on_sigusr1(self) -> None:
        if pool_platform.is_windows():
            self.skipTest("no SIGUSR1 on Windows")
        import signal as real_signal
        import faulthandler as real_faulthandler

        with tempfile.TemporaryFile(mode="w+") as out:
            self.assertTrue(pool_platform.register_stack_dump_signal(stream=out))
            try:
                os.kill(os.getpid(), real_signal.SIGUSR1)
                out.seek(0)
                self.assertIn("test_real_registration_dumps_this_thread_on_sigusr1", out.read())
            finally:
                real_faulthandler.unregister(real_signal.SIGUSR1)


if __name__ == "__main__":
    unittest.main()
