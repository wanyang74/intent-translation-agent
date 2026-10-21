// Reads the PNGs Chrome writes, for comparing screenshots: 8-bit RGB or RGBA, not interlaced. Enough for our own
// screenshots; not a general PNG decoder.
import { inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row by row. */
  data: Uint8Array;
}

/**
 * Decodes a PNG:
 *   1. Read the chunks: the header (size and color type) and the compressed image data, which may span several.
 *   2. Inflate, then undo each row's filter (PNG predicts every byte from its left, upper and upper-left neighbors).
 *   3. Expand RGB to RGBA.
 */
export function decodePng(png: Buffer): Pixels {
  // 1. Chunks: length, type, data, CRC, after an 8-byte signature.
  let width = 0, height = 0, colorType = 0;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('only 8-bit, non-interlaced RGB or RGBA PNGs');
    } else if (type === 'IDAT') {
      compressed.push(data);
    }
    offset += 12 + length;
  }

  // 2. Unfilter.
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels]! : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? rows[(y - 1) * stride + x - channels]! : 0;
      const paeth = () => {
        const estimate = left + up - upLeft;
        const [toLeft, toUp, toUpLeft] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      };
      const predicted = [0, left, up, (left + up) >> 1, paeth()][filter] ?? 0;
      rows[y * stride + x] = (raw[source + x]! + predicted) & 0xff;
    }
  }

  // 3. RGBA.
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set(rows.subarray(i * 3, i * 3 + 3), i * 4);
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** The share of pixels that differ noticeably (any channel by more than `tolerance`); 1 when the sizes differ. */
export function differentPixels(expected: Pixels, actual: Pixels, tolerance = 24): number {
  if (expected.width !== actual.width || expected.height !== actual.height) return 1;
  let different = 0;
  for (let i = 0; i < expected.data.length; i += 4) {
    for (let channel = 0; channel < 4; channel++) {
      if (Math.abs(expected.data[i + channel]! - actual.data[i + channel]!) > tolerance) {
        different++;
        break;
      }
    }
  }
  return different / (expected.width * expected.height);
}
