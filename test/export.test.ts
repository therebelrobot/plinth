import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeLayers } from '../src/core/compose';
import { encodePsd, packBits } from '../src/core/psd';
import { renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS } from '../src/core/types';
import { createZip } from '../src/core/zip';
import { sampleObjects } from './sample-scene';

function unpackBits(packed: Uint8Array, expected: number): Uint8Array {
  const output: number[] = [];
  let index = 0;
  while (output.length < expected) {
    const header = packed[index++];
    if (header < 128) { for (let count = 0; count <= header; count++) output.push(packed[index++]); }
    else if (header > 128) { const value = packed[index++]; for (let count = 0; count < 257 - header; count++) output.push(value); }
  }
  return Uint8Array.from(output);
}

test('packBits round-trips', () => {
  const samples = [
    Uint8Array.from([1, 1, 1, 1, 2, 3, 4, 4, 5]),
    new Uint8Array(300).fill(7),
    Uint8Array.from({ length: 300 }, (_, index) => index % 251),
    Uint8Array.from([9]),
  ];
  for (const sample of samples) assert.deepEqual(unpackBits(packBits(sample), sample.length), sample);
});

const directory = mkdtempSync(join(tmpdir(), 'plinth-'));

function python(script: string, ...args: string[]): string | null {
  try {
    return execFileSync('python3', ['-c', script, ...args], { encoding: 'utf8' });
  } catch (error) {
    const message = String((error as { stderr?: string }).stderr ?? error);
    if (message.includes('ModuleNotFoundError')) return null;
    throw new Error(message);
  }
}

test('layered PSD opens in psd-tools with expected layers', (context) => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 8, floorTilesY: 8 };
  const buffers = renderScene(settings, sampleObjects(), DEFAULT_RENDER_OPTIONS);
  const layers = composeLayers(buffers, DEFAULT_RENDER_OPTIONS, settings);
  const path = join(directory, 'scene.psd');
  writeFileSync(path, encodePsd(buffers.width, buffers.height, layers));
  const output = python(
    `import sys
from psd_tools import PSDImage
psd = PSDImage.open(sys.argv[1])
print(psd.width, psd.height)
for layer in psd:
    img = layer.topil()
    print(layer.name, img.mode, img.getbbox() is not None)
comp = psd.composite()
print('composite', comp.size)`,
    path,
  );
  if (output === null) return context.skip('psd-tools not installed');
  const lines = output.trim().split('\n');
  assert.equal(lines[0], `${buffers.width} ${buffers.height}`);
  const names = lines.slice(1, -1).map((line) => line.split(' RGBA')[0]);
  assert.deepEqual(names, layers.map((layer) => layer.name));
  assert.ok(names.includes('Level 0') && names.includes('Level 1') && names.includes('Level 2'));
  for (const line of lines.slice(1, -1)) assert.ok(line.endsWith('True'), line);
});

test('zip is valid', (context) => {
  const path = join(directory, 'kit.zip');
  writeFileSync(path, createZip([
    { name: 'a.txt', data: new TextEncoder().encode('hello') },
    { name: 'folder/b.bin', data: new Uint8Array(1000).fill(3) },
  ]));
  const output = python(
    `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(','.join(z.namelist()), z.read('a.txt').decode())`,
    path,
  );
  if (output === null) return context.skip('python zipfile unavailable');
  assert.equal(output.trim(), 'a.txt,folder/b.bin hello');
});
