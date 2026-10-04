// Dev aid: render a sample scene to PNG.  npx tsx test/preview.ts out.png [scale]
import { writeFileSync } from 'node:fs';
import { composeImage, upscale } from '../src/core/compose';
import { renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, type SceneObject } from '../src/core/types';
import { sampleObjects } from './sample-scene';
import { encodePng } from './png-node';

const outputPath = process.argv[2] ?? 'preview.png';
const scale = Number(process.argv[3] ?? 4);
const shading = (process.argv[4] ?? 'shaded') as typeof DEFAULT_RENDER_OPTIONS.shading;
const settings = { ...DEFAULT_SETTINGS, floorTilesX: 8, floorTilesY: 8, levelCount: 4 };
const options = { ...DEFAULT_RENDER_OPTIONS, shading };
const objects: SceneObject[] = sampleObjects();
const started = performance.now();
const buffers = renderScene(settings, objects, options);
const image = composeImage(buffers, { ...options, background: 'white' }, settings);
console.log(`rendered ${buffers.width}×${buffers.height} in ${(performance.now() - started).toFixed(1)}ms`);
writeFileSync(outputPath, encodePng(upscale(image, buffers.width, buffers.height, scale), buffers.width * scale, buffers.height * scale));
