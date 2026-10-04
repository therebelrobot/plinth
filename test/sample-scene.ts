import type { PrimitiveType, Rotation, SceneObject } from '../src/core/types';

let counter = 0;
export function makeObject(
  type: PrimitiveType, x: number, y: number, z: number,
  width = 1, depth = 1, height = 1, rotation: Rotation = 0, parameter?: number,
): SceneObject {
  return { id: `o${counter++}`, type, x, y, z, width, depth, height, rotation, parameter };
}

/** A small multi-level scene that exercises every primitive. */
export function sampleObjects(): SceneObject[] {
  return [
    makeObject('wall', 0, 0, 0, 1, 6, 3, 0, 0.25),
    makeObject('wall', 0, 0, 0, 6, 1, 3, 1, 0.25),
    makeObject('block', 1, 1, 0, 3, 2, 1),
    makeObject('block', 1, 1, 1, 2, 2, 1),
    makeObject('stairs', 4, 1, 0, 1, 2, 1, 2, 4),
    makeObject('block', 2, 4, 0),
    makeObject('block', 3, 4, 0),
    makeObject('ramp', 4, 4, 0, 1, 1, 1, 0),
    makeObject('cylinder', 6, 1, 0, 1, 1, 2),
    makeObject('sphere', 6, 1, 2),
    makeObject('cone', 6, 4, 0, 1, 1, 2),
    makeObject('pyramid', 1, 1, 2, 2, 2, 1),
    makeObject('arch', 0, 3, 0, 1, 2, 3, 0, 0.25),
    makeObject('block', 5, 6, 0, 2, 1, 0.5),
  ];
}
