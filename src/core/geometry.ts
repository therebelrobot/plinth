// Analytic ray/primitive intersection in a primitive's canonical frame.
//
// Mechanism: every screen pixel is a ray along the iso view direction. The
// renderer converts that ray into each object's local frame — translated to the
// object's origin and un-rotated so the shape always faces the same way — and
// asks for the *largest* ray parameter t inside the solid. Larger t = closer to
// the viewer, so the largest t is the visible surface. The z-buffer then keeps
// the largest t across objects, which is what makes overlapping primitives
// occlude each other correctly without any sort order.
//
// Canonical frame: the shape occupies [0,A] × [0,B] × [0,H]. Directional
// shapes are authored "facing +x" (toward the viewer's right side at rotation 0):
//   - wall:   a slab hugging the low-x edge, lx ∈ [0, thickness]
//   - stairs: risers face +x; steps climb toward low x
//   - ramp:   slope faces +x, rising toward low x
//   - arch:   a wall at the low-x edge with a round-topped opening through it

import type { PrimitiveType } from './types';

export interface Hit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  /** Curved surfaces get no internal face edges and stable normal-based shading. */
  curved: boolean;
}

export function makeHit(): Hit {
  return { t: -Infinity, nx: 0, ny: 0, nz: 1, curved: false };
}

const EPSILON = 1e-9;

function setNormal(out: Hit, nx: number, ny: number, nz: number): void {
  const length = Math.hypot(nx, ny, nz) || 1;
  out.nx = nx / length;
  out.ny = ny / length;
  out.nz = nz / length;
}

/**
 * Axis-aligned box. Writes the far (viewer-side) hit into `out`.
 * Returns false when the ray misses. Also exposes the near bound via the return-
 * by-reference `interval` so CSG callers can use both ends.
 */
const interval = { near: 0, far: 0, farAxis: 0, farSign: 0, nearAxis: 0, nearSign: 0 };

// Slab test, one axis at a time, without per-call allocation (this runs per pixel).
function slab(axis: number, low: number, high: number, origin: number, direction: number): boolean {
  if (Math.abs(direction) < EPSILON) return origin >= low && origin <= high;
  let tLow = (low - origin) / direction;
  let tHigh = (high - origin) / direction;
  // The ray leaves through the high face when moving +, the low face when moving −.
  let exitSign = 1;
  if (tLow > tHigh) {
    const swap = tLow; tLow = tHigh; tHigh = swap;
    exitSign = -1;
  }
  if (tLow > interval.near) { interval.near = tLow; interval.nearAxis = axis; interval.nearSign = -exitSign; }
  if (tHigh < interval.far) { interval.far = tHigh; interval.farAxis = axis; interval.farSign = exitSign; }
  return true;
}

function boxInterval(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  px: number, py: number, pz: number, dx: number, dy: number, dz: number,
): boolean {
  interval.near = -Infinity;
  interval.far = Infinity;
  interval.farAxis = 0; interval.farSign = 0; interval.nearAxis = 0; interval.nearSign = 0;
  if (!slab(0, x0, x1, px, dx)) return false;
  if (!slab(1, y0, y1, py, dy)) return false;
  if (!slab(2, z0, z1, pz, dz)) return false;
  return interval.near <= interval.far;
}

function intersectBox(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  px: number, py: number, pz: number, dx: number, dy: number, dz: number,
  out: Hit,
): boolean {
  if (!boxInterval(x0, x1, y0, y1, z0, z1, px, py, pz, dx, dy, dz)) return false;
  out.t = interval.far;
  out.nx = interval.farAxis === 0 ? interval.farSign : 0;
  out.ny = interval.farAxis === 1 ? interval.farSign : 0;
  out.nz = interval.farAxis === 2 ? interval.farSign : 0;
  out.curved = false;
  return true;
}

/** Convex polyhedron given as half-spaces n·p ≤ d, packed [nx, ny, nz, d, ...]. */
function intersectHalfSpaces(
  planes: readonly number[],
  px: number, py: number, pz: number, dx: number, dy: number, dz: number,
  out: Hit,
): boolean {
  let near = -Infinity;
  let far = Infinity;
  let farPlane = -1;
  for (let index = 0; index < planes.length; index += 4) {
    const nx = planes[index], ny = planes[index + 1], nz = planes[index + 2], d = planes[index + 3];
    const denominator = nx * dx + ny * dy + nz * dz;
    const numerator = d - (nx * px + ny * py + nz * pz);
    if (Math.abs(denominator) < EPSILON) {
      if (numerator < 0) return false;
      continue;
    }
    const tPlane = numerator / denominator;
    if (denominator > 0) {
      if (tPlane < far) { far = tPlane; farPlane = index; }
    } else if (tPlane > near) {
      near = tPlane;
    }
  }
  if (farPlane < 0 || near > far) return false;
  out.t = far;
  setNormal(out, planes[farPlane], planes[farPlane + 1], planes[farPlane + 2]);
  out.curved = false;
  return true;
}

function boxPlanes(a: number, b: number, h: number): number[] {
  return [
    -1, 0, 0, 0, 1, 0, 0, a,
    0, -1, 0, 0, 0, 1, 0, b,
    0, 0, -1, 0, 0, 0, 1, h,
  ];
}

/** Solve a t² + b t + c = 0; returns false for no real roots. Roots land in `roots` ascending. */
const roots = { low: 0, high: 0 };
function solveQuadratic(a: number, b: number, c: number): boolean {
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return false;
    roots.low = roots.high = -c / b;
    return true;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return false;
  const root = Math.sqrt(discriminant);
  // Numerically stable form.
  const q = -0.5 * (b + Math.sign(b || 1) * root);
  let first = q / a;
  let second = Math.abs(q) < EPSILON ? first : c / q;
  if (first > second) { const swap = first; first = second; second = swap; }
  roots.low = first; roots.high = second;
  return true;
}

/**
 * A full-height box in a wall's canonical frame (x = thickness axis, y = run
 * axis). Feature 4 unions these with the wall slab so perpendicular walls meet
 * as a solid mitre at a shared corner.
 */
export interface CornerPost {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface CanonicalShape {
  type: PrimitiveType;
  a: number; // extent along canonical x
  b: number; // extent along canonical y
  h: number; // extent along z
  parameter: number;
  /** Walls only: 0 = flat top, 1 = full run-axis slope. */
  slope: number;
  /** Precomputed half-spaces for polyhedral types (ramp, pyramid, sloped wall). */
  planes: number[];
  /** Optional corner-post boxes (Feature 4); absent for every non-wall shape. */
  posts?: CornerPost[];
}

export function prepareShape(
  type: PrimitiveType, a: number, b: number, h: number, parameter: number,
  posts?: CornerPost[], slope = 0, slopeDirection: 1 | -1 = 1,
): CanonicalShape {
  let planes: number[] = [];
  if (type === 'ramp') {
    // Box ∩ { lz ≤ h·(1 − lx/a) }  ⇔  (h/a)·lx + lz ≤ h
    planes = boxPlanes(a, b, h);
    planes.push(h / a, 0, 1, h);
  } else if (type === 'pyramid') {
    // Base plus four faces meeting at the apex over the footprint centre.
    planes = [
      0, 0, -1, 0,
      -(2 * h) / a, 0, 1, 0,
      (2 * h) / a, 0, 1, 2 * h,
      0, -(2 * h) / b, 1, 0,
      0, (2 * h) / b, 1, 2 * h,
    ];
  } else if (type === 'wall' && slope > 0) {
    // Sloped wall: the ramp construction rotated onto the wall's run axis (y).
    // The slab is x ∈ [0, thickness]; the cut plane is (0, h/(slope·b), 1, h/slope)
    // for a rise at the low-y end, mirrored for a rise at the high-y end. A single
    // plane covers both the full slope (slope = 1) and the partial slope with a
    // flat shoulder at the tall end, because the box's own top plane clamps the
    // shoulder. Convex, so it routes through intersectHalfSpaces.
    const thickness = Math.min(parameter, a);
    const clamped = Math.min(Math.max(slope, 0), 1);
    planes = boxPlanes(thickness, b, h);
    const run = clamped * b;
    if (run > 0) {
      const rise = h / run;
      if (slopeDirection < 0) {
        // Rise at the high-y end: lz ≤ (h/(slope·b))·ly.
        planes.push(0, -rise, 1, 0);
      } else {
        // Rise at the low-y end: lz ≤ h/slope − (h/(slope·b))·ly.
        planes.push(0, rise, 1, h / clamped);
      }
    }
  }
  return { type, a, b, h, parameter, slope: type === 'wall' ? slope : 0, planes, ...(posts && posts.length > 0 ? { posts } : {}) };
}

/**
 * Intersect a ray (origin p, direction d) with a shape in its canonical frame.
 * Writes the visible (largest-t) hit. Returns false on a miss.
 */
export function intersectCanonical(
  shape: CanonicalShape,
  px: number, py: number, pz: number, dx: number, dy: number, dz: number,
  out: Hit,
): boolean {
  const { a, b, h } = shape;
  switch (shape.type) {
    case 'block':
      return intersectBox(0, a, 0, b, 0, h, px, py, pz, dx, dy, dz, out);

    case 'wall': {
      const thickness = Math.min(shape.parameter, a);
      // Union of the slab with any corner posts (Feature 4): the visible point of
      // a union is the max over parts, exactly as the stairs case does. A sloped
      // wall's slab is a convex half-space set instead of a box.
      let found = shape.slope > 0
        ? intersectHalfSpaces(shape.planes, px, py, pz, dx, dy, dz, out)
        : intersectBox(0, thickness, 0, b, 0, h, px, py, pz, dx, dy, dz, out);
      let bestT = found ? out.t : -Infinity;
      let bestNx = out.nx, bestNy = out.ny, bestNz = out.nz;
      if (shape.posts) {
        for (const post of shape.posts) {
          if (intersectBox(post.x0, post.x1, post.y0, post.y1, 0, h, px, py, pz, dx, dy, dz, out) && out.t > bestT) {
            found = true;
            bestT = out.t; bestNx = out.nx; bestNy = out.ny; bestNz = out.nz;
          }
        }
      }
      if (!found) return false;
      out.t = bestT; out.nx = bestNx; out.ny = bestNy; out.nz = bestNz; out.curved = false;
      return true;
    }

    case 'stairs': {
      // Union of n boxes: step i spans lx ∈ [0, a·(n−i)/n], lz ∈ [0, h·(i+1)/n].
      // Visible point of a union = max over parts.
      const stepCount = Math.max(1, Math.round(shape.parameter));
      let found = false;
      let bestT = -Infinity, bestNx = 0, bestNy = 0, bestNz = 0;
      for (let step = 0; step < stepCount; step++) {
        const reach = (a * (stepCount - step)) / stepCount;
        const top = (h * (step + 1)) / stepCount;
        if (intersectBox(0, reach, 0, b, 0, top, px, py, pz, dx, dy, dz, out) && out.t > bestT) {
          found = true;
          bestT = out.t; bestNx = out.nx; bestNy = out.ny; bestNz = out.nz;
        }
      }
      if (!found) return false;
      out.t = bestT; out.nx = bestNx; out.ny = bestNy; out.nz = bestNz; out.curved = false;
      return true;
    }

    case 'ramp':
    case 'pyramid':
      return intersectHalfSpaces(shape.planes, px, py, pz, dx, dy, dz, out);

    case 'cylinder': {
      // Vertical elliptic cylinder inscribed in the footprint.
      const radiusX = a / 2, radiusY = b / 2;
      const ox = (px - radiusX) / radiusX, oy = (py - radiusY) / radiusY;
      const ex = dx / radiusX, ey = dy / radiusY;
      if (!solveQuadratic(ex * ex + ey * ey, 2 * (ox * ex + oy * ey), ox * ox + oy * oy - 1)) return false;
      const tBottom = (0 - pz) / dz;
      const tTop = (h - pz) / dz;
      const zLow = Math.min(tBottom, tTop), zHigh = Math.max(tBottom, tTop);
      const near = Math.max(roots.low, zLow);
      const far = Math.min(roots.high, zHigh);
      if (near > far) return false;
      out.t = far;
      if (far === roots.high && roots.high < zHigh) {
        const sx = ox + far * ex, sy = oy + far * ey;
        setNormal(out, sx / radiusX, sy / radiusY, 0);
        out.curved = true;
      } else {
        out.nx = 0; out.ny = 0; out.nz = dz > 0 ? 1 : -1;
        out.curved = false;
      }
      return true;
    }

    case 'sphere': {
      // Ellipsoid inscribed in the bounding box.
      const radiusX = a / 2, radiusY = b / 2, radiusZ = h / 2;
      const ox = (px - radiusX) / radiusX, oy = (py - radiusY) / radiusY, oz = (pz - radiusZ) / radiusZ;
      const ex = dx / radiusX, ey = dy / radiusY, ez = dz / radiusZ;
      if (!solveQuadratic(ex * ex + ey * ey + ez * ez, 2 * (ox * ex + oy * ey + oz * ez), ox * ox + oy * oy + oz * oz - 1)) return false;
      const far = roots.high;
      out.t = far;
      setNormal(out, (ox + far * ex) / radiusX, (oy + far * ey) / radiusY, (oz + far * ez) / radiusZ);
      out.curved = true;
      return true;
    }

    case 'cone': {
      // X² + Y² ≤ (1 − z/h)², 0 ≤ z ≤ h. The visible exit is the largest root
      // whose z lies on the real (lower) nappe; the base is never viewer-facing.
      const radiusX = a / 2, radiusY = b / 2;
      const ox = (px - radiusX) / radiusX, oy = (py - radiusY) / radiusY;
      const ex = dx / radiusX, ey = dy / radiusY;
      const oz = 1 - pz / h, ez = -dz / h; // Z' = 1 − z/h
      if (!solveQuadratic(ex * ex + ey * ey - ez * ez, 2 * (ox * ex + oy * ey - oz * ez), ox * ox + oy * oy - oz * oz)) return false;
      for (let pass = 0; pass < 2; pass++) {
        const candidate = pass === 0 ? roots.high : roots.low;
        const z = pz + candidate * dz;
        if (z >= -1e-9 && z <= h + 1e-9) {
          const sx = ox + candidate * ex, sy = oy + candidate * ey, sz = oz + candidate * ez;
          out.t = candidate;
          setNormal(out, sx / radiusX, sy / radiusY, sz / h);
          out.curved = true;
          return true;
        }
      }
      return false;
    }

    case 'arch': {
      // Wall slab minus (round-top opening): a half-disc cylinder along x
      // unioned with the rectangular opening below its spring line.
      const thickness = Math.min(shape.parameter, a);
      if (!boxInterval(0, thickness, 0, b, 0, h, px, py, pz, dx, dy, dz)) return false;
      const boxNear = interval.near;
      let t = interval.far;
      let nx = interval.farAxis === 0 ? interval.farSign : 0;
      let ny = interval.farAxis === 1 ? interval.farSign : 0;
      let nz = interval.farAxis === 2 ? interval.farSign : 0;
      let curved = false;

      const legWidth = Math.min(0.25, b * 0.25);
      const radius = b / 2 - legWidth;
      const lintel = Math.min(0.25, h * 0.2);
      const springLine = Math.max(0, h - lintel - radius);
      const centreY = b / 2;

      // Subtractor 1: rectangular opening (unbounded in x).
      let openingNear = Infinity, openingFar = -Infinity, openingNy = 0, openingNz = 0;
      if (radius > 0 && boxInterval(-1e9, 1e9, centreY - radius, centreY + radius, -1e9, springLine, px, py, pz, dx, dy, dz)) {
        openingNear = interval.near; openingFar = interval.far;
        openingNy = interval.nearAxis === 1 ? interval.nearSign : 0;
        openingNz = interval.nearAxis === 2 ? interval.nearSign : 0;
      }
      // Subtractor 2: horizontal cylinder along x through the spring line.
      let roundNear = Infinity, roundFar = -Infinity;
      if (radius > 0) {
        const oy = (py - centreY) / radius, oz = (pz - springLine) / radius;
        const ey = dy / radius, ez = dz / radius;
        if (solveQuadratic(ey * ey + ez * ez, 2 * (oy * ey + oz * ez), oy * oy + oz * oz - 1)) {
          roundNear = roots.low; roundFar = roots.high;
        }
      }
      // Walk t downward out of any subtractor that contains it. The visible
      // surface is then the subtractor's entry face, seen from inside: normal flipped.
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        if (t > openingNear && t <= openingFar) {
          t = openingNear; nx = 0; ny = -openingNy; nz = -openingNz; curved = false; moved = true;
        }
        if (t > roundNear && t <= roundFar) {
          t = roundNear;
          const sy = (py + t * dy - centreY) / radius, sz = (pz + t * dz - springLine) / radius;
          nx = 0; ny = -sy; nz = -sz; curved = true; moved = true;
        }
        if (!moved) break;
      }
      if (t < boxNear) return false;
      out.t = t;
      setNormal(out, nx, ny, nz);
      out.curved = curved;
      return true;
    }
  }
}
