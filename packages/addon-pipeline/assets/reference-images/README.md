# Benchmark Reference Images

Images sourced from [Unsplash](https://unsplash.com/) under the [Unsplash License](https://unsplash.com/license) — free to use for any purpose.

| Filename | Content | Tests |
|----------|---------|-------|
| `3-persons.jpg` | 3 people in office, frontal faces | Person detection, face detection |
| `1-car-plate.jpg` | Single car, plate "EA 0202 AA" | Vehicle detection, plate detection + OCR |
| `2-cars-plates.jpg` | 2 cars, plate "CNE 844Y", people in background | Multi-vehicle, plate, person detection |
| `persons-cars-animal.jpg` | 3 people, dog, BMW | Person + face + animal + vehicle detection |

## Ground Truth

Each image has a corresponding `ground-truth/<name>.json` with pixel-coordinate bounding boxes and annotations for expected detections.

The ground truth is approximate — bounding boxes are hand-estimated. Accuracy metrics (mAP50) use IoU threshold of 0.5 which tolerates minor bbox imprecision.
