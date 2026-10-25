"""Per-accelerator compute the Auto tune estimate scales from (D930).

OpenVINO devices are enumerated here — the same place the pool already asks
`available_devices` — and an AMD WebGPU adapter is read when the plugin
exposes one. A query that fails is ``None``, never ``0`` (D393): zero would
scale the device as if it had no compute.

The pool publishes the list to the temp file the platform probe reads back
onto ``HardwareInfo.accelerators``. Importing this module does not import
OpenVINO or ONNX Runtime.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Any, Optional

# One file per host. The inference worker writes it; platform-probe reads it.
# Two pools (GPU and NPU) merge by deviceKey.
FACTS_FILENAME = "camstack-accelerator-facts.json"

_GOPS_INT8 = ("i8", "int8", "u8", "bin")
_GOPS_FP16 = ("f16", "fp16", "bf16")
_CLOCK_PROPERTIES = (
    "GPU_DEVICE_MAX_FREQUENCY",
    "GPU_MAX_FREQUENCY",
    "GPU_FREQUENCY",
)
_TOPS_PROPERTIES = ("NPU_MAX_TOPS", "DEVICE_TOPS")
_CU_ATTRIBUTES = ("compute_units", "cu_count", "max_compute_units")
_VENDOR_ATTRIBUTES = ("vendor", "vendor_name", "vendorName")
_ARCH_ATTRIBUTES = ("architecture", "arch")
_DEVICE_ATTRIBUTES = ("device", "device_name", "name", "description")


def facts_path() -> str:
    return os.path.join(tempfile.gettempdir(), FACTS_FILENAME)


def _positive(value: Any) -> Optional[float]:
    """A reported number, or None when the query failed or answered <= 0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number <= 0 or number != number:  # NaN
        return None
    return number


def _text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _blank(device_key: str) -> dict:
    return {
        "deviceKey": device_key,
        "fullDeviceName": None,
        "executionUnits": None,
        "clockMHz": None,
        "gops": None,
        "architecture": None,
        "npuName": None,
        "tops": None,
        "vendor": None,
        "webgpuArchitecture": None,
        "webgpuDevice": None,
        "computeUnits": None,
    }


def _property(core: Any, device: str, name: str) -> Any:
    try:
        return core.get_property(device, name)
    except Exception:
        return None


def _first_property(core: Any, device: str, names: tuple) -> Any:
    for name in names:
        value = _property(core, device, name)
        if value is not None:
            return value
    return None


def _gops(raw: Any) -> Optional[dict]:
    """``DEVICE_GOPS`` as ``{int8, fp16}``. None when the query itself failed."""
    if raw is None:
        return None
    try:
        items = list(raw.items())
    except Exception:
        return None
    int8 = None
    fp16 = None
    for key, value in items:
        name = str(key).lower().rsplit(".", 1)[-1]
        if name in _GOPS_INT8:
            int8 = _positive(value)
        elif name in _GOPS_FP16:
            fp16 = _positive(value)
    return {"int8": int8, "fp16": fp16}


def _device_key(ov_name: str, index: int) -> Optional[str]:
    upper = ov_name.upper()
    if "NPU" in upper:
        kind = "npu"
    elif "GPU" in upper:
        kind = "gpu"
    else:
        return None
    if index == 0:
        return f"openvino:{kind}"
    return f"openvino:{kind}:{index}"


def collect_openvino_device_facts(core: Any) -> Optional[list]:
    """One record per GPU and NPU. None when the device list itself failed."""
    try:
        available = list(core.available_devices)
    except Exception:
        return None
    seen = {"gpu": 0, "npu": 0}
    facts: list = []
    for ov_name in available:
        upper = str(ov_name).upper()
        if "NPU" in upper:
            kind = "npu"
        elif "GPU" in upper:
            kind = "gpu"
        else:
            continue
        key = _device_key(str(ov_name), seen[kind])
        seen[kind] += 1
        if key is None:
            continue
        record = _blank(key)
        name = _text(_property(core, ov_name, "FULL_DEVICE_NAME"))
        record["fullDeviceName"] = name
        record["architecture"] = _text(_property(core, ov_name, "DEVICE_ARCHITECTURE"))
        record["gops"] = _gops(_property(core, ov_name, "DEVICE_GOPS"))
        if kind == "gpu":
            record["executionUnits"] = _positive(
                _property(core, ov_name, "GPU_EXECUTION_UNITS_COUNT")
            )
            record["clockMHz"] = _positive(_first_property(core, ov_name, _CLOCK_PROPERTIES))
        else:
            record["npuName"] = name
            record["tops"] = _positive(_first_property(core, ov_name, _TOPS_PROPERTIES))
        facts.append(record)
        sys.stderr.write(
            f"accelerator facts: {key} name={name} "
            f"eu={record['executionUnits']} clockMHz={record['clockMHz']} "
            f"gops={record['gops']} arch={record['architecture']} tops={record['tops']}\n"
        )
        sys.stderr.flush()
    return facts


def _attr(obj: Any, names: tuple) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        for name in names:
            if name in obj and obj[name] is not None:
                return obj[name]
        return None
    for name in names:
        if hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None:
                return value
    return None


def webgpu_facts_from_device(device: Any) -> Optional[dict]:
    """Adapter fields off an ORT / Dawn device. None when there is no device."""
    if device is None:
        return None
    record = _blank("onnx:webgpu")
    record["vendor"] = _text(_attr(device, _VENDOR_ATTRIBUTES))
    record["webgpuArchitecture"] = _text(_attr(device, _ARCH_ATTRIBUTES))
    record["webgpuDevice"] = _text(_attr(device, _DEVICE_ATTRIBUTES))
    record["computeUnits"] = _positive(_attr(device, _CU_ATTRIBUTES))
    return record


def publish_accelerator_facts(facts: list, path: Optional[str] = None) -> None:
    """Merge ``facts`` into the published file by deviceKey. Atomic replace."""
    target = path if path is not None else facts_path()
    current: list = []
    try:
        with open(target, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, dict) and isinstance(payload.get("accelerators"), list):
            current = [row for row in payload["accelerators"] if isinstance(row, dict)]
    except (OSError, ValueError):
        current = []
    by_key = {row.get("deviceKey"): row for row in current if isinstance(row.get("deviceKey"), str)}
    for row in facts:
        key = row.get("deviceKey")
        if isinstance(key, str):
            by_key[key] = row
    merged = [by_key[key] for key in sorted(by_key)]
    tmp = f"{target}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"accelerators": merged}, handle)
    os.replace(tmp, target)


def facts_for_runtime(runtime: str, runtime_lib: Any, device: str) -> Optional[list]:
    """Facts for the runtime this pool just initialised. None when it cannot ask."""
    if runtime == "openvino":
        return collect_openvino_device_facts(runtime_lib)
    if runtime == "onnxruntime" and device.strip().lower() == "webgpu":
        one = _probe_webgpu_adapter()
        return None if one is None else [one]
    return None


def _probe_webgpu_adapter() -> Optional[dict]:
    """Best-effort adapter read. None when the plugin or the device is absent."""
    try:
        import onnxruntime as ort
        import onnxruntime_ep_webgpu as webgpu_ep
    except Exception:
        return None
    try:
        ep_name = webgpu_ep.get_ep_name()
        device = next(
            (item for item in ort.get_ep_devices() if getattr(item, "ep_name", None) == ep_name),
            None,
        )
    except Exception:
        return None
    return webgpu_facts_from_device(device)


def _probe_openvino() -> Optional[list]:
    try:
        from openvino import Core
    except Exception as exc:
        sys.stderr.write(f"accelerator facts: OpenVINO unavailable ({exc})\n")
        sys.stderr.flush()
        return None
    try:
        return collect_openvino_device_facts(Core())
    except Exception as exc:
        sys.stderr.write(f"accelerator facts: OpenVINO probe failed ({exc})\n")
        sys.stderr.flush()
        return None


def main() -> int:
    """Print ``{"accelerators": ...}``. ``null`` when nothing could be asked."""
    ov = _probe_openvino()
    web = _probe_webgpu_adapter()
    if ov is None and web is None:
        sys.stdout.write(json.dumps({"accelerators": None}) + "\n")
        return 0
    facts = [] if ov is None else list(ov)
    if web is not None:
        facts.append(web)
    sys.stdout.write(json.dumps({"accelerators": facts}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
