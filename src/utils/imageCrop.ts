import sharp from 'sharp';

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getCenterCropRegion(origWidth: number, origHeight: number, targetWidth = 1280, targetHeight = 720): CropRegion {
  const targetRatio = targetWidth / targetHeight;
  const origRatio = origWidth / origHeight;

  if (origRatio > targetRatio) {
    const width = origHeight * targetRatio;
    const x = (origWidth - width) / 2;
    return { x, y: 0, width, height: origHeight };
  }

  const height = origWidth / targetRatio;
  const y = (origHeight - height) / 2;
  return { x: 0, y, width: origWidth, height };
}

export async function getCroppedImg(
  image: Buffer | ArrayBuffer | string,
  cropRegion: CropRegion,
  outputWidth: number,
  outputHeight: number
): Promise<Buffer> {
  let buffer: Buffer;
  if (typeof image === 'string') {
    const res = await fetch(image);
    buffer = Buffer.from(await res.arrayBuffer());
  } else if (image instanceof ArrayBuffer) {
    buffer = Buffer.from(image);
  } else {
    buffer = image;
  }

  return await sharp(buffer)
    .extract({
      left: Math.round(cropRegion.x),
      top: Math.round(cropRegion.y),
      width: Math.round(cropRegion.width),
      height: Math.round(cropRegion.height)
    })
    .resize(outputWidth, outputHeight)
    .toFormat('jpeg')
    .toBuffer();
}

