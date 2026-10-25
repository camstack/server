# YOLOv9-s for the Coral Edge TPU — corresponding source

The two `.tflite` files under `objectDetection/yolov9/tflite/` are mirrored
UNCHANGED from Dan Brown's releases of
https://github.com/dbro/frigate-detector-edgetpu-yolo9 (repository commit
d8ddfdaee7af76bf3847274604a5ecff0d8c1cc4, mirrored 2026-10-22):

| File | Release | SHA-256 |
| --- | --- | --- |
| yolov9-s-relu6-best_320_int8_edgetpu.tflite | v1.0 | 49a38e77439b475d0d259a6d9fe7ea32fcaa58de3748499dd120aceebad9c591 |
| yolov9-s-relu6-tpumax_512_int8_edgetpu.tflite | v1.5 | f634f60259101556825fd69662f96282e74364b507f83e6382cc34d5d0e6170e |

Corresponding source, in this directory:

- `yolov9-s-relu6-best.pt` — the fine-tuned PyTorch checkpoint (release v1.0,
  SHA-256 0005b3e03044acb007dbc1d6be2d1040b64ca98e5d2c30aaf5678f0935c6ebf9).
- `notebooks/Fine_tune_YOLOv9_s_for_EdgeTPU_use_ReLU6_and_17_COCO_classes.ipynb`
  — the fine-tuning recipe (ReLU6 activations, 17 COCO classes).
- `notebooks/Convert_YOLO_v9_ReLU6_PyTorch_format_to_EdgeTPU_for_Google_Coral.ipynb`
  — the PyTorch → int8 TFLite → edgetpu_compiler conversion.
- `labels-coco17.txt`, `README.md`, `LICENSE.md` — as published.

Licences:

- Weights: derived from WongKinYiu/yolov9 `yolov9-s-converted.pt`,
  GPL-3.0 (https://github.com/WongKinYiu/yolov9). The training code is that
  repository.
- Notebooks and plugin code: MIT, © 2025 Dan Brown (`LICENSE.md`).
- Training data: COCO 2017, filtered to 17 classes.

CamStack does not modify these files; it decodes their output with its own
`yolo-split-dfl` postprocessor.
