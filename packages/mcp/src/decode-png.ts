import { inflateSync } from 'node:zlib';

// The tests read the pixels of the PNGs that render_board and flatten draw with decodePng.

/** A picture's pixels: 4 bytes each, red, green, blue and alpha, row by row from the top. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decodes a PNG of 8 bits a channel, RGB or RGBA and not interlaced, as resvg writes it. Throws on any other PNG. */
export function decodePng(png: Buffer): Pixels {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, at) => png[at] === byte)) throw new Error("The bytes don't start with a PNG's signature.");
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) {
        throw new Error(`The PNG has the depth ${body[8]}, the color type ${body[9]} and the interlace ${body[12]}, which decodePng doesn't read.`);
      }
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      rows[y * stride + x] = (line[x] + predicted(filter, left, up, corner)) & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 4; channel++) {
      pixels[pixel * 4 + channel] = channel < channels ? rows[pixel * channels + channel] : 255;
    }
  }
  return { width, height, data: pixels };
}

/** The byte that a PNG row's filter predicts from the bytes to its left, above it, and above and left of it. */
function predicted(filter: number, left: number, up: number, corner: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - corner;
      const fromLeft = Math.abs(estimate - left);
      const fromUp = Math.abs(estimate - up);
      const fromCorner = Math.abs(estimate - corner);
      if (fromLeft <= fromUp && fromLeft <= fromCorner) return left;
      return fromUp <= fromCorner ? up : corner;
    }
    default:
      throw new Error(`A PNG row has the filter ${filter}, which PNG doesn't define.`);
  }
}
