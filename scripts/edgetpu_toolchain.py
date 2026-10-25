"""Shared Edge TPU toolchain for the Coral build scripts (D710).

Imported by ``build-yunet-edgetpu.py``, ``build-yolox-plate-edgetpu.py`` and
``build-edgetpu-sets.py``. ``build-bird-classifier-edgetpu.py`` predates it and
keeps its own copy of the compiler pins below; the two MUST name the same
compiler (a co-compiled set is only coherent when every member is compiled by
one compiler run).

What lives here, and nothing else:

- the pinned ``edgetpu_compiler`` bundle (version 14.1, Google's own binary,
  loader and libs from ``google-coral/edgetpu``; the apt repository that
  carried 15/16 answers 403 since Coral support ended);
- running it in a ``linux/amd64`` container, through Docker or a Lima VM
  (``limactl start --name=coral --vm-type=vz --rosetta template:default``;
  Lima 2 shares no writable host directory, so inputs are copied in and the
  outputs copied back);
- reading its log: per model, ops mapped to the TPU vs the CPU, on-chip
  parameter cache, streamed parameters.

Every compile writes a fresh random 8-byte parameter-cache token (twice in the
file), so two runs differ in exactly 16 bytes and the sha256 never matches a
hosted file. Co-compiled members share ONE token: that is what keeps them from
evicting each other on the Edge TPU.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import urllib.request
from hashlib import sha256
from pathlib import Path

COMPILER_COMMIT = "3b625cddfe8886f15978221a02cda2e52044b24c"
_COMPILER = (
    f"https://raw.githubusercontent.com/google-coral/edgetpu/{COMPILER_COMMIT}"
    "/compiler/x86_64/edgetpu_compiler_bin"
)
COMPILER_FILES = (
    ("edgetpu_compiler", "5482d4627920e7b0c0c9fb4b1dcaa941bbdb47430fd5a28fbbd13b3bf8415679", 19_613_568),
    ("ld-linux-x86-64.so.2", "0d3fc8700afd0fbdfd63af0aba794e5bc4260b679f03e93a6f792e4fe2d522a9", 169_552),
    ("libc++.so.1", "457fb2108a42215e0da9990bbbdd0d910ffef8f85bc87f422832b6e2764ddb5f", 788_920),
    ("libc++abi.so.1", "435713546d48e6aeefa765f983a90393b5b992307c76176774ca31e28fdba282", 211_616),
    ("libc.so.6", "fd8496fe7ae47c79dbacd411af3c6f63f821201150c9ca99f1e833f7b2d972e9", 1_795_984),
    ("libdl.so.2", "9ce41c740532940d1c625a3afd8159d44c86721fb7dcc06438be45e1e3560a89", 14_448),
    ("libm.so.6", "6bde953e2692494c9aa1aaa01a7d14196c7603d1a8f20ed7a55d4e804f9151a5", 1_435_680),
    ("libpthread.so.0", "67443ab4f157a3acebb514d6a7505ac76f22052004eabb6ea9a3688ccf6f0e8f", 105_496),
    ("libresolv.so.2", "8bf1a5049e7a3ddbde2c2b86983fa239fd4eb096356479dc3c305af76abda05a", 84_008),
    ("librt.so.1", "bd0cd2f5be13a5a12a79b19699aa4330b57628cef5eb6fa5bc09a948e05c405d", 31_056),
)
COMPILER_IMAGE = "debian:bookworm-slim"
_BIN = "edgetpu_compiler_bin"

# The root detector's CPU sibling (google-coral/test_data, Apache-2.0): the file
# the catalog's `ssd-mobilenet-v2-coco-edgetpu` was compiled from, and the
# first member of every set that hosts the root.
CORAL_TEST_DATA_COMMIT = "104342d2d3480b3e66203073dac24f4e2dbb4c41"
_CORAL = f"https://raw.githubusercontent.com/google-coral/test_data/{CORAL_TEST_DATA_COMMIT}"
SRC_SSD_QUANT = (f"{_CORAL}/ssd_mobilenet_v2_coco_quant_postprocess.tflite", "ssd_quant.tflite",
                 "42fb3d70ffb7bb37dd518f730f7be784b831c2078f30c497d0019cc2e987fa26", 6_220_797)
SRC_BIRD_QUANT = (f"{_CORAL}/mobilenet_v2_1.0_224_inat_bird_quant.tflite", "bird_quant.tflite",
                  "350fcd8cf1df1560060d464595dfed8b174b05792788052896004848d9ad04f9", 3_579_500)


def fetch(src: tuple[str, str, str, int], dest_dir: Path) -> Path:
    """Download ``(url, name, sha256, bytes)`` into ``dest_dir`` once; refuse a mismatch."""
    url, name, digest, size = src
    dest = dest_dir / name
    if not dest.exists():
        print(f"  fetch {url}")
        with urllib.request.urlopen(url) as resp, dest.open("wb") as out:
            shutil.copyfileobj(resp, out)
    data = dest.read_bytes()
    if len(data) != size or sha256(data).hexdigest() != digest:
        dest.unlink()
        raise SystemExit(f"{name}: size/sha256 mismatch (expected {size} bytes, {digest})")
    return dest


def fetch_compiler(work: Path) -> Path:
    """The pinned compiler bundle (binary + its own loader and libs), sha256-checked."""
    bin_dir = work / _BIN
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name, digest, size in COMPILER_FILES:
        fetch((f"{_COMPILER}/{name}", name, digest, size), bin_dir)
    for name in ("edgetpu_compiler", "ld-linux-x86-64.so.2"):
        (bin_dir / name).chmod(0o755)
    return bin_dir


def _script(jobs: list[tuple[str, list[str]]]) -> str:
    """One shell line per job: ``tpuc -s -o <outdir> <models…>`` (order = cache priority)."""
    lines = ["set -e", "B=$PWD/" + _BIN,
             'tpuc() { "$B/ld-linux-x86-64.so.2" --library-path "$B" "$B/edgetpu_compiler" "$@"; }',
             "tpuc --version"]
    for out_dir, models in jobs:
        lines.append(f"mkdir -p {out_dir}")
        lines.append(f"tpuc -s -o {out_dir} {' '.join(models)} > {out_dir}/compiler.txt 2>&1"
                     f" || {{ cat {out_dir}/compiler.txt; exit 1; }}")
    return "; ".join(lines)


def compile_jobs(compiler: str, work: Path, inputs: list[Path], jobs: list[tuple[str, list[str]]]) -> None:
    """Run ``edgetpu_compiler`` for each job inside an amd64 container.

    ``inputs`` are copied into the container's work dir under their own names;
    each job names its output dir (relative) and the input file names, in
    cache-priority order. The output dirs land back under ``work``.
    """
    fetch_compiler(work)
    for out_dir, _ in jobs:
        shutil.rmtree(work / out_dir, ignore_errors=True)
    script = _script(jobs)
    if compiler == "docker":
        for p in inputs:
            if p.parent != work:
                shutil.copyfile(p, work / p.name)
        subprocess.run(["docker", "run", "--rm", "--platform", "linux/amd64", "-v", f"{work}:/work",
                        "-w", "/work", COMPILER_IMAGE, "bash", "-c", script], check=True)
        return
    if not compiler.startswith("lima:"):
        raise SystemExit(f"unknown --compiler {compiler!r} (docker | lima:<instance>)")
    vm = compiler.split(":", 1)[1]
    vm_work = f"/tmp/camstack-edgetpu-{work.name}"
    shell = ["limactl", "shell", "--workdir", "/", vm]
    subprocess.run([*shell, "bash", "-c", f"rm -rf {vm_work} && mkdir -p {vm_work}"], check=True)
    for item in [work / _BIN, *inputs]:
        subprocess.run(["limactl", "copy", "-r", str(item), f"{vm}:{vm_work}/"], check=True)
    subprocess.run([*shell, "nerdctl", "run", "--rm", "--platform", "linux/amd64", "-v", f"{vm_work}:/work",
                    "-w", "/work", COMPILER_IMAGE, "bash", "-c", script], check=True)
    tar = subprocess.run([*shell, "tar", "-C", vm_work, "-cf", "-", *[d for d, _ in jobs]],
                         check=True, capture_output=True).stdout
    subprocess.run(["tar", "-C", str(work), "-xf", "-"], input=tar, check=True)


_UNIT = {"B": 1, "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3}


def _bytes(text: str) -> int:
    value, unit = re.fullmatch(r"([\d.]+)\s*(B|KiB|MiB|GiB)", text.strip()).groups()
    return round(float(value) * _UNIT[unit])


def parse_compiler_output(text: str) -> list[dict]:
    """Per input model, in compile order: on-chip / streamed bytes and op mapping."""
    models: list[dict] = []
    for block in re.split(r"\n(?=Input model: )", text):
        name = re.search(r"Input model: (\S+)", block)
        if name is None:
            continue
        on_chip = re.search(r"On-chip memory used for caching model parameters: (.+)", block)
        streamed = re.search(r"Off-chip memory used for streaming uncached model parameters: (.+)", block)
        total = re.search(r"Total number of operations: (\d+)", block)
        cpu = re.search(r"Number of operations that will run on CPU: (\d+)", block)
        subgraphs = re.search(r"Number of Edge TPU subgraphs: (\d+)", block)
        ops_total = int(total.group(1)) if total else 0
        ops_cpu = int(cpu.group(1)) if cpu else 0
        models.append({
            "model": name.group(1),
            "on_chip_bytes": _bytes(on_chip.group(1)) if on_chip else None,
            "streamed_bytes": _bytes(streamed.group(1)) if streamed else None,
            "ops_total": ops_total,
            "ops_tpu": ops_total - ops_cpu,
            "ops_cpu": ops_cpu,
            "subgraphs": int(subgraphs.group(1)) if subgraphs else None,
        })
    return models


def mib(n: int | None) -> str:
    return "?" if n is None else f"{n / 1024 ** 2:.2f} MiB"
