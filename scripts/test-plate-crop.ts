import sharp from 'sharp'
import * as path from 'path'
import * as fs from 'fs'

const ROOT = path.resolve(__dirname, '..')
const imgPath = path.join(ROOT, 'assets/reference-images/1-car-plate.jpg')

async function main() {
  const jpeg = fs.readFileSync(imgPath)
  const meta = await sharp(jpeg).metadata()
  console.log('Image size:', meta.width, 'x', meta.height)

  // From the pipeline response:
  const vehicleBbox = { x: 178.75, y: 166.5, w: 938.5, h: 642 }
  const plateBboxCropRelative = { x: 121.9, y: 410.08, w: 186.06, h: 52.82 }
  const plateBboxImageSpace = {
    x: vehicleBbox.x + plateBboxCropRelative.x,
    y: vehicleBbox.y + plateBboxCropRelative.y,
    w: plateBboxCropRelative.w,
    h: plateBboxCropRelative.h,
  }

  console.log('Vehicle bbox:', vehicleBbox)
  console.log('Plate bbox (crop-relative):', plateBboxCropRelative)
  console.log('Plate bbox (image-space):', plateBboxImageSpace)

  // Crop 1: plate from original image using image-space coords (what pipeline does NOW)
  const crop1 = await sharp(jpeg)
    .extract({
      left: Math.round(plateBboxImageSpace.x),
      top: Math.round(plateBboxImageSpace.y),
      width: Math.round(plateBboxImageSpace.w),
      height: Math.round(plateBboxImageSpace.h),
    })
    .jpeg()
    .toBuffer()
  fs.writeFileSync('/tmp/plate-crop-imagespace.jpg', crop1)

  // Crop 2: vehicle first, then plate from vehicle (the CORRECT two-step approach)
  const vehicleCrop = await sharp(jpeg)
    .extract({
      left: Math.round(vehicleBbox.x),
      top: Math.round(vehicleBbox.y),
      width: Math.round(vehicleBbox.w),
      height: Math.round(vehicleBbox.h),
    })
    .jpeg()
    .toBuffer()
  fs.writeFileSync('/tmp/vehicle-crop.jpg', vehicleCrop)

  const crop2 = await sharp(vehicleCrop)
    .extract({
      left: Math.round(plateBboxCropRelative.x),
      top: Math.round(plateBboxCropRelative.y),
      width: Math.round(plateBboxCropRelative.w),
      height: Math.round(plateBboxCropRelative.h),
    })
    .jpeg()
    .toBuffer()
  fs.writeFileSync('/tmp/plate-crop-fromvehicle.jpg', crop2)

  // Crop 3: plate directly from image using crop-relative coords (WRONG — what might be happening)
  const crop3 = await sharp(jpeg)
    .extract({
      left: Math.round(plateBboxCropRelative.x),
      top: Math.round(plateBboxCropRelative.y),
      width: Math.round(plateBboxCropRelative.w),
      height: Math.round(plateBboxCropRelative.h),
    })
    .jpeg()
    .toBuffer()
  fs.writeFileSync('/tmp/plate-crop-wrongcoords.jpg', crop3)

  console.log('\nSaved:')
  console.log(
    '  /tmp/plate-crop-imagespace.jpg  — from original image, image-space coords (pipeline approach)',
  )
  console.log(
    '  /tmp/plate-crop-fromvehicle.jpg — from vehicle crop, crop-relative coords (correct 2-step)',
  )
  console.log(
    '  /tmp/plate-crop-wrongcoords.jpg — from original image, crop-relative coords (WRONG)',
  )
  console.log(
    '\nOpen all three and compare. If imagespace ≠ fromvehicle, the pipeline has a crop bug.',
  )
}

main().catch(console.error)
