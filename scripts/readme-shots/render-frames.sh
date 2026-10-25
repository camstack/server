#!/bin/bash
# Synthetic README stills. Flat shapes only — the UI supplies the names.
set -euo pipefail
OUT="${1:?output dir}"
mkdir -p "$OUT/scenes" "$OUT/crops"
scene() {
  local name="$1" sky="$2" ground="$3"
  shift 3
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=${sky}:s=1280x720:d=1" \
    -frames:v 1 \
    -vf "drawbox=x=0:y=430:w=1280:h=290:color=${ground}:t=fill,${*}" \
    -q:v 3 "$OUT/scenes/${name}.jpg"
}

# door, window, path
scene front-door 0x87b7d4 0x6b8f71 \
  "drawbox=x=560:y=250:w=180:h=280:color=0x8d5a34:t=fill,drawbox=x=620:y=360:w=18:h=18:color=0xf2d48a:t=fill,drawbox=x=200:y=180:w=220:h=160:color=0xd7e6f2:t=fill,drawbox=x=860:y=200:w=40:h=220:color=0x3d4a3a:t=fill"
# driveway and a car
scene driveway 0xb7c4ce 0x8d8d86 \
  "drawbox=x=280:y=470:w=720:h=160:color=0x5c6168:t=fill,drawbox=x=420:y=360:w=280:h=110:color=0x2f5f8a:t=fill,drawbox=x=450:y=385:w=90:h=40:color=0xc5d8ea:t=fill,drawbox=x=580:y=385:w=90:h=40:color=0xc5d8ea:t=fill"
scene garage 0x3a4450 0x2a3038 \
  "drawbox=x=240:y=220:w=800:h=380:color=0x6e532c:t=fill,drawbox=x=280:y=260:w=340:h=280:color=0x8a6a3c:t=fill,drawbox=x=660:y=260:w=340:h=280:color=0x8a6a3c:t=fill"
scene porch 0xf0c27a 0x7d9a6a \
  "drawbox=x=180:y=300:w=920:h=40:color=0xc4a574:t=fill,drawbox=x=220:y=340:w=24:h=200:color=0xefe6d6:t=fill,drawbox=x=1040:y=340:w=24:h=200:color=0xefe6d6:t=fill,drawbox=x=700:y=250:w=70:h=90:color=0xf7f1c8:t=fill"
scene garden 0x8ec6e6 0x4f8a45 \
  "drawbox=x=160:y=360:w=40:h=180:color=0x6b4a2b:t=fill,drawbox=x=100:y=280:w=160:h=100:color=0x2f7d32:t=fill,drawbox=x=860:y=390:w=36:h=150:color=0x6b4a2b:t=fill,drawbox=x=800:y=300:w=150:h=110:color=0x3e9140:t=fill,drawbox=x=480:y=500:w=220:h=40:color=0xe24b4b:t=fill"
scene side-gate 0x9bb7c9 0x6d7c55 \
  "drawbox=x=520:y=220:w=16:h=360:color=0x4a4a4a:t=fill,drawbox=x=720:y=220:w=16:h=360:color=0x4a4a4a:t=fill,drawbox=x=520:y=280:w=216:h=12:color=0x4a4a4a:t=fill,drawbox=x=520:y=360:w=216:h=12:color=0x4a4a4a:t=fill,drawbox=x=520:y=440:w=216:h=12:color=0x4a4a4a:t=fill"
scene back-yard 0x6aa0c8 0x3f7a3a \
  "drawbox=x=0:y=500:w=1280:h=80:color=0x3d6b38:t=fill,drawbox=x=300:y=420:w=680:h=90:color=0xd8efe4:t=fill,drawbox=x=980:y=300:w=30:h=220:color=0x5a4030:t=fill,drawbox=x=900:y=220:w=180:h=100:color=0x2e6b32:t=fill"
scene hallway 0xd9d3c7 0xb7aa9a \
  "drawbox=x=0:y=0:w=180:h=720:color=0xc8bfb0:t=fill,drawbox=x=1100:y=0:w=180:h=720:color=0xc8bfb0:t=fill,drawbox=x=460:y=160:w=360:h=420:color=0xefeae2:t=fill,drawbox=x=620:y=340:w=40:h=40:color=0xe0b15a:t=fill"
scene patio 0x5c88b0 0x6a8f62 \
  "drawbox=x=200:y=460:w=880:h=30:color=0xd7c4a3:t=fill,drawbox=x=260:y=380:w=80:h=80:color=0x8d5a34:t=fill,drawbox=x=900:y=390:w=80:h=70:color=0x8d5a34:t=fill,drawbox=x=520:y=300:w=240:h=20:color=0xf4f4f4:t=fill"

crop() {
  local name="$1" bg="$2"
  shift 2
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=${bg}:s=320x320:d=1" \
    -frames:v 1 \
    -vf "$*" \
    -q:v 3 "$OUT/crops/${name}.jpg"
}

crop person 0x87b7d4 \
  "drawbox=x=118:y=36:w=84:h=84:color=0xf0c9a0:t=fill,drawbox=x=96:y=130:w=128:h=110:color=0x355f8a:t=fill,drawbox=x=108:y=240:w=40:h=60:color=0x2c3e50:t=fill,drawbox=x=172:y=240:w=40:h=60:color=0x2c3e50:t=fill"
crop car 0xb7c4ce \
  "drawbox=x=40:y=140:w=240:h=80:color=0x2f5f8a:t=fill,drawbox=x=70:y=100:w=160:h=50:color=0x3d78a8:t=fill,drawbox=x=60:y=210:w=48:h=48:color=0x222222:t=fill,drawbox=x=210:y=210:w=48:h=48:color=0x222222:t=fill"
crop dog 0x8ec6e6 \
  "drawbox=x=70:y=150:w=170:h=70:color=0xc4a574:t=fill,drawbox=x=200:y=110:w=60:h=60:color=0xc4a574:t=fill,drawbox=x=60:y=120:w=30:h=50:color=0xc4a574:t=fill,drawbox=x=90:y=210:w=22:h=40:color=0x8d6a3c:t=fill,drawbox=x=190:y=210:w=22:h=40:color=0x8d6a3c:t=fill"
crop package 0xf0c27a \
  "drawbox=x=70:y=90:w=180:h=150:color=0xc48a3a:t=fill,drawbox=x=70:y=150:w=180:h=16:color=0x8d5a2b:t=fill,drawbox=x=148:y=90:w=16:h=150:color=0x8d5a2b:t=fill"
crop bike 0x9bb7c9 \
  "drawbox=x=50:y=150:w=70:h=70:color=0x222222:t=fill,drawbox=x=200:y=150:w=70:h=70:color=0x222222:t=fill,drawbox=x=80:y=120:w=150:h=16:color=0xd0d5da:t=fill,drawbox=x=140:y=70:w=16:h=90:color=0xd0d5da:t=fill"

echo "frames in $OUT"
