"""CamStack trainer: fine-tune a root detector on a hub's annotated export.

The hub never imports this package. It talks to it through files only:
``job.json`` + ``dataset.tar`` in, ``bundle.tar`` + ``result.json`` out, and
``CAMSTACK_EVENT`` lines on stdout. Ultralytics (AGPL-3.0) is imported only by
``train_det`` and the export steps, inside this image.
"""

__version__ = "0.1.0"
