// Minimal layered PSD writer (8-bit RGB + alpha, PackBits-compressed).
// Procreate imports PSD layers as separate layers, which is the point: each
// level of the scene, the floor, the grid and the outlines arrive separately.
//
// Spec reference: Adobe Photoshop File Format Specification, sections
// "File Header", "Layer and Mask Information", "Image Data".

import type { ImageLayer } from './compose';

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private current = new Uint8Array(1 << 16);
  private offset = 0;
  length = 0;

  private ensure(size: number): void {
    if (this.offset + size <= this.current.length) return;
    this.chunks.push(this.current.subarray(0, this.offset));
    this.current = new Uint8Array(Math.max(1 << 16, size));
    this.offset = 0;
  }
  u8(value: number): void { this.ensure(1); this.current[this.offset++] = value & 0xff; this.length += 1; }
  u16(value: number): void { this.u8(value >>> 8); this.u8(value); }
  i16(value: number): void { this.u16(value & 0xffff); }
  u32(value: number): void { this.u16((value >>> 16) & 0xffff); this.u16(value & 0xffff); }
  ascii(text: string): void { for (let index = 0; index < text.length; index++) this.u8(text.charCodeAt(index)); }
  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.current.set(data, this.offset);
    this.offset += data.length;
    this.length += data.length;
  }
  finish(): Uint8Array {
    this.chunks.push(this.current.subarray(0, this.offset));
    const output = new Uint8Array(this.length);
    let position = 0;
    for (const chunk of this.chunks) { output.set(chunk, position); position += chunk.length; }
    return output;
  }
}

/** PackBits one row. */
export function packBits(row: Uint8Array): Uint8Array {
  const output: number[] = [];
  let index = 0;
  while (index < row.length) {
    // Run of identical bytes?
    let run = 1;
    while (index + run < row.length && run < 128 && row[index + run] === row[index]) run++;
    if (run >= 2) {
      output.push(257 - run, row[index]);
      index += run;
      continue;
    }
    // Literal span until the next run of ≥ 2 (or 128 bytes).
    let literal = 1;
    while (
      index + literal < row.length &&
      literal < 128 &&
      !(index + literal + 1 < row.length && row[index + literal] === row[index + literal + 1])
    ) literal++;
    output.push(literal - 1);
    for (let offset = 0; offset < literal; offset++) output.push(row[index + offset]);
    index += literal;
  }
  return Uint8Array.from(output);
}

/** Split interleaved RGBA into one plane per channel. */
function planes(rgba: Uint8ClampedArray, size: number): Uint8Array[] {
  const red = new Uint8Array(size), green = new Uint8Array(size), blue = new Uint8Array(size), alpha = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    red[index] = rgba[index * 4];
    green[index] = rgba[index * 4 + 1];
    blue[index] = rgba[index * 4 + 2];
    alpha[index] = rgba[index * 4 + 3];
  }
  return [red, green, blue, alpha];
}

interface EncodedChannel { rowLengths: number[]; rows: Uint8Array[]; byteLength: number }

function encodeChannel(plane: Uint8Array, width: number, height: number): EncodedChannel {
  const rows: Uint8Array[] = [];
  const rowLengths: number[] = [];
  let byteLength = 0;
  for (let y = 0; y < height; y++) {
    const packed = packBits(plane.subarray(y * width, (y + 1) * width));
    rows.push(packed);
    rowLengths.push(packed.length);
    byteLength += packed.length;
  }
  return { rows, rowLengths, byteLength };
}

function pascalName(name: string): Uint8Array {
  const ascii = name.replace(/[^\x20-\x7e]/g, '?').slice(0, 255);
  const total = Math.ceil((ascii.length + 1) / 4) * 4; // padded to a multiple of 4
  const output = new Uint8Array(total);
  output[0] = ascii.length;
  for (let index = 0; index < ascii.length; index++) output[index + 1] = ascii.charCodeAt(index);
  return output;
}

/** Composite of layers (normal blending, straight alpha) for the flattened preview section. */
function flatten(layers: ImageLayer[], size: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(size * 4);
  for (const layer of layers) {
    if (layer.hidden) continue;
    for (let index = 0; index < size; index++) {
      const offset = index * 4;
      const alpha = layer.rgba[offset + 3] / 255;
      if (alpha === 0) continue;
      const below = output[offset + 3] / 255;
      const outAlpha = alpha + below * (1 - alpha);
      for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = (layer.rgba[offset + channel] * alpha + output[offset + channel] * below * (1 - alpha)) / outAlpha;
      }
      output[offset + 3] = outAlpha * 255;
    }
  }
  return output;
}

export function encodePsd(width: number, height: number, layers: ImageLayer[]): Uint8Array {
  const size = width * height;
  const writer = new ByteWriter();

  // ── File header
  writer.ascii('8BPS');
  writer.u16(1); // version
  for (let index = 0; index < 6; index++) writer.u8(0);
  writer.u16(4); // channels in merged image (RGB + alpha)
  writer.u32(height);
  writer.u32(width);
  writer.u16(8); // bits per channel
  writer.u16(3); // RGB

  writer.u32(0); // colour mode data
  writer.u32(0); // image resources

  // ── Layer records + channel data, built separately so we know the length.
  const layerInfo = new ByteWriter();
  layerInfo.i16(layers.length);
  const channelOrder = [0, 1, 2, -1]; // R, G, B, transparency
  const encodedLayers = layers.map((layer) => planes(layer.rgba, size).map((plane) => encodeChannel(plane, width, height)));

  layers.forEach((layer, layerIndex) => {
    layerInfo.u32(0); layerInfo.u32(0); layerInfo.u32(height); layerInfo.u32(width); // top, left, bottom, right
    layerInfo.u16(4);
    encodedLayers[layerIndex].forEach((channel, channelIndex) => {
      layerInfo.i16(channelOrder[channelIndex]);
      layerInfo.u32(2 + height * 2 + channel.byteLength); // compression + row table + data
    });
    layerInfo.ascii('8BIM');
    layerInfo.ascii('norm');
    layerInfo.u8(255); // opacity
    layerInfo.u8(0); // clipping
    layerInfo.u8(layer.hidden ? 0b10 : 0); // flags: bit 1 = hidden
    layerInfo.u8(0); // filler
    const name = pascalName(layer.name);
    layerInfo.u32(4 + 4 + name.length); // extra data: mask len + blending len + name
    layerInfo.u32(0); // layer mask data
    layerInfo.u32(0); // blending ranges
    layerInfo.bytes(name);
  });

  encodedLayers.forEach((channels) => {
    for (const channel of channels) {
      layerInfo.u16(1); // RLE
      for (const length of channel.rowLengths) layerInfo.u16(length);
      for (const row of channel.rows) layerInfo.bytes(row);
    }
  });
  if (layerInfo.length % 2 === 1) layerInfo.u8(0);
  const layerInfoBytes = layerInfo.finish();

  writer.u32(4 + layerInfoBytes.length + 4); // layer & mask section length
  writer.u32(layerInfoBytes.length); // layer info length
  writer.bytes(layerInfoBytes);
  writer.u32(0); // global layer mask info

  // ── Merged image (RLE): all row lengths for all channels, then all rows.
  const merged = planes(flatten(layers, size), size).map((plane) => encodeChannel(plane, width, height));
  writer.u16(1);
  for (const channel of merged) for (const length of channel.rowLengths) writer.u16(length);
  for (const channel of merged) for (const row of channel.rows) writer.bytes(row);

  return writer.finish();
}
