#!/usr/bin/env python3
"""
Export all detection models to supported formats.

Exports:
  - YOLOv8 nano→xlarge → ONNX, CoreML, OpenVINO, TFLite
  - YOLOv9 tiny/small/compact → ONNX, CoreML, OpenVINO, TFLite
  - YOLO11 nano→xlarge → ONNX, CoreML, OpenVINO, TFLite
  - YOLO11-seg nano/small/medium → ONNX, CoreML, OpenVINO
  - YOLOv8-seg nano/small/medium → ONNX, CoreML, OpenVINO
  - UltraFace slim-320 → already ONNX (download only)

Output: ./exported-models/{model_name}.{format}

Usage: python3 scripts/export-models.py [--output-dir ./exported-models]
"""

import os
import sys
import shutil
from pathlib import Path

OUTPUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("exported-models")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Models to export via Ultralytics
ULTRALYTICS_MODELS = [
    # YOLOv8 detection
    ("yolov8n", 640),
    ("yolov8s", 640),
    ("yolov8m", 640),
    ("yolov8l", 640),
    ("yolov8x", 640),
    # YOLOv9 detection
    ("yolov9t", 640),
    ("yolov9s", 640),
    ("yolov9c", 640),
    # YOLO11 detection
    ("yolo11n", 640),
    ("yolo11s", 640),
    ("yolo11m", 640),
    ("yolo11l", 640),
    ("yolo11x", 640),
    # YOLO11 segmentation
    ("yolo11n-seg", 640),
    ("yolo11s-seg", 640),
    ("yolo11m-seg", 640),
    # YOLOv8 segmentation
    ("yolov8n-seg", 640),
    ("yolov8s-seg", 640),
    ("yolov8m-seg", 640),
]

# Formats to export
FORMATS = {
    "onnx": {"format": "onnx", "ext": ".onnx"},
    "coreml": {"format": "coreml", "ext": ".mlpackage", "half": True},
    "openvino": {"format": "openvino", "ext": "_openvino_model"},
    "tflite": {"format": "tflite", "ext": ".tflite"},
}

def export_ultralytics(model_name: str, imgsz: int):
    """Export a single Ultralytics model to all formats."""
    from ultralytics import YOLO

    print(f"\n{'='*60}")
    print(f"Exporting {model_name} (input: {imgsz}x{imgsz})")
    print(f"{'='*60}")

    # Load model (downloads .pt automatically)
    model = YOLO(f"{model_name}.pt")

    for fmt_name, fmt_config in FORMATS.items():
        try:
            print(f"\n  → {fmt_name}...")
            export_kwargs = {"format": fmt_config["format"], "imgsz": imgsz}
            if fmt_config.get("half"):
                export_kwargs["half"] = True
            exported_path = model.export(**export_kwargs)

            if exported_path and os.path.exists(exported_path):
                # Move to output directory
                dest_name = f"{model_name}{fmt_config['ext']}"
                dest_path = OUTPUT_DIR / dest_name

                if os.path.isdir(exported_path):
                    if dest_path.exists():
                        shutil.rmtree(dest_path)
                    shutil.copytree(exported_path, dest_path)
                else:
                    shutil.copy2(exported_path, dest_path)

                size_mb = get_size_mb(dest_path)
                print(f"    ✓ {dest_name} ({size_mb:.1f} MB)")
            else:
                print(f"    ✗ Export returned no path")
        except Exception as e:
            print(f"    ✗ {fmt_name} failed: {e}")


def download_external_model(name: str, url: str, filename: str):
    """Download a pre-existing ONNX model."""
    dest = OUTPUT_DIR / filename
    if dest.exists():
        print(f"  ✓ {filename} already exists ({get_size_mb(dest):.1f} MB)")
        return

    print(f"\n  → Downloading {name}...")
    import urllib.request
    try:
        urllib.request.urlretrieve(url, dest)
        print(f"    ✓ {filename} ({get_size_mb(dest):.1f} MB)")
    except Exception as e:
        print(f"    ✗ Download failed: {e}")


def get_size_mb(path: Path) -> float:
    """Get file/directory size in MB."""
    if path.is_file():
        return path.stat().st_size / (1024 * 1024)
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return total / (1024 * 1024)


def main():
    print(f"Output directory: {OUTPUT_DIR.resolve()}")

    # Export Ultralytics models
    for model_name, imgsz in ULTRALYTICS_MODELS:
        export_ultralytics(model_name, imgsz)

    # Download pre-existing models
    print(f"\n{'='*60}")
    print("Downloading pre-existing ONNX models")
    print(f"{'='*60}")

    download_external_model(
        "UltraFace Slim 320",
        "https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx/version-slim-320.onnx",
        "ultraface-slim-320.onnx",
    )

    download_external_model(
        "CLIP ViT-B/32",
        "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx",
        "clip-vit-b32.onnx",
    )

    # Summary
    print(f"\n{'='*60}")
    print("Export complete! Files:")
    print(f"{'='*60}")
    total_mb = 0
    for f in sorted(OUTPUT_DIR.iterdir()):
        size = get_size_mb(f)
        total_mb += size
        print(f"  {f.name:40s} {size:8.1f} MB")
    print(f"  {'─'*50}")
    print(f"  {'Total':40s} {total_mb:8.1f} MB")
    print(f"\nUpload these to GitHub Releases:")
    print(f"  gh release create models-v1.0 {OUTPUT_DIR}/* --title 'Model Assets v1.0'")


if __name__ == "__main__":
    main()
