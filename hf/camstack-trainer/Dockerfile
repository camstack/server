# Tracked in camstack/server as hf/camstack-trainer/Dockerfile; edit it there, not on the Hub.
#
# The CamStack trainer image. Two builders read this file:
#   - `docker build --platform linux/amd64 --build-arg TRAINER_REVISION=<sha> .` (any registry);
#   - the hub's Modal provider, which builds it WITHOUT a build context:
#     FROM becomes `images.fromRegistry(...)` and every other line one
#     `dockerfileCommands` entry.
# So, load-bearing:
#   - only FROM, ARG, ENV, RUN and WORKDIR — never COPY or ADD (there is no context);
#   - one instruction per line, no backslash continuations (the hub splits on lines);
#   - every pip version pinned; the trainer itself installed from this repository
#     at TRAINER_REVISION (the hub passes the exact commit it was released with).
FROM pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime
ARG TRAINER_REVISION=main
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV TRAINER_REVISION=${TRAINER_REVISION}
ENV YOLO_CONFIG_DIR=/tmp/ultralytics
RUN apt-get update && apt-get install -y --no-install-recommends git libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install "camstack-train[train,export] @ git+https://huggingface.co/camstack/camstack-trainer@${TRAINER_REVISION}"
RUN python -c "import camstack_train, ultralytics, openvino, nncf, coremltools; print('trainer', camstack_train.__version__)"
WORKDIR /app
CMD ["python", "-m", "camstack_train", "--help"]
