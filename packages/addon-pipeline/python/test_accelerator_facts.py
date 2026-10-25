"""Unit tests for accelerator compute facts (D930). No OpenVINO import."""
import json
import os
import tempfile
import unittest

import accelerator_facts as facts


class _Core:
    def __init__(self, devices, props):
        self.available_devices = devices
        self._props = props
        self.failed = set()

    def get_property(self, device, name):
        if (device, name) in self.failed:
            raise RuntimeError(f"probe failed {device} {name}")
        device_props = self._props.get(device, {})
        if name not in device_props:
            raise KeyError(name)
        return device_props[name]


class OpenVinoFactsTest(unittest.TestCase):
    def test_reports_gpu_and_npu_and_null_for_a_failed_query(self):
        core = _Core(
            ["CPU", "GPU", "NPU"],
            {
                "GPU": {
                    "FULL_DEVICE_NAME": "Intel(R) Graphics",
                    "GPU_EXECUTION_UNITS_COUNT": 32,
                    "GPU_DEVICE_MAX_FREQUENCY": 1250,
                    "DEVICE_GOPS": {"i8": 400, "f16": 200},
                    "DEVICE_ARCHITECTURE": "Xe",
                },
                "NPU": {
                    "FULL_DEVICE_NAME": "Intel AI Boost",
                    "DEVICE_ARCHITECTURE": "NPU",
                    "NPU_MAX_TOPS": 10,
                },
            },
        )
        core.failed.add(("GPU", "DEVICE_ARCHITECTURE"))
        rows = facts.collect_openvino_device_facts(core)
        self.assertEqual([row["deviceKey"] for row in rows], ["openvino:gpu", "openvino:npu"])
        gpu = rows[0]
        self.assertEqual(gpu["executionUnits"], 32)
        self.assertEqual(gpu["clockMHz"], 1250)
        self.assertEqual(gpu["gops"], {"int8": 400, "fp16": 200})
        self.assertIsNone(gpu["architecture"])
        self.assertEqual(rows[1]["npuName"], "Intel AI Boost")
        self.assertEqual(rows[1]["tops"], 10)
        self.assertIsNone(rows[1]["executionUnits"])

    def test_a_zero_eu_count_is_null(self):
        core = _Core(
            ["GPU"],
            {"GPU": {"FULL_DEVICE_NAME": "Intel", "GPU_EXECUTION_UNITS_COUNT": 0}},
        )
        rows = facts.collect_openvino_device_facts(core)
        self.assertIsNone(rows[0]["executionUnits"])
        self.assertIsNone(rows[0]["gops"])

    def test_a_failed_device_list_is_none(self):
        class Boom:
            @property
            def available_devices(self):
                raise RuntimeError("no core")

        self.assertIsNone(facts.collect_openvino_device_facts(Boom()))


class WebGpuFactsTest(unittest.TestCase):
    def test_reads_adapter_fields_and_leaves_a_missing_cu_null(self):
        row = facts.webgpu_facts_from_device(
            {"vendor": "amd", "architecture": "rdna3", "device": "gfx1103"}
        )
        self.assertEqual(row["deviceKey"], "onnx:webgpu")
        self.assertEqual(row["vendor"], "amd")
        self.assertEqual(row["webgpuArchitecture"], "rdna3")
        self.assertEqual(row["webgpuDevice"], "gfx1103")
        self.assertIsNone(row["computeUnits"])
        self.assertIsNone(facts.webgpu_facts_from_device(None))


class PublishTest(unittest.TestCase):
    def test_merges_by_device_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "facts.json")
            facts.publish_accelerator_facts(
                [facts.webgpu_facts_from_device({"vendor": "amd", "compute_units": 12})],
                path,
            )
            gpu = facts._blank("openvino:gpu")
            gpu["executionUnits"] = 24
            facts.publish_accelerator_facts([gpu], path)
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            keys = [row["deviceKey"] for row in payload["accelerators"]]
            self.assertEqual(keys, ["onnx:webgpu", "openvino:gpu"])


if __name__ == "__main__":
    unittest.main()
