# Plinth

Plinth is an isometric pixel-art scene editor: it composes primitive shapes into
scenes, renders them to greyscale or colour, and exports layered PSDs and tilesets.

## Language

### Scene model

**Scene**:
A saved isometric composition — settings plus placed objects — persisted as one JSON document.
_Avoid_: scene file, blocking, document

**Scene document**:
The persisted JSON shape holding version, name, settings, objects, and optional imports.
_Avoid_: file, save

**Scene object**:
One placed primitive, with position, size, rotation, and type-specific parameters.
_Avoid_: piece, item, object

**Scene settings**:
Scene-wide geometry — tile and level pixel sizes, floor size, headroom, base thickness, padding, snap.
_Avoid_: settings, config

**Primitive**:
One of the nine shape kinds: block, wall, stairs, ramp, cylinder, sphere, cone, pyramid, arch.
_Avoid_: shape, piece

**Primitive preset**:
A named starting size for a primitive, such as block, slab, plate, or wall.
_Avoid_: palette entry, shape

**Rotation**:
A quarter-turn about the vertical axis, 0–3.
_Avoid_: facing, direction

**Footprint**:
The width × depth extent of an object, in tiles.
_Avoid_: size

**Level**:
The vertical unit; one level equals one world unit of height.
_Avoid_: z, floor

**Tile**:
One floor cell, 1×1 world units in x and y.
_Avoid_: cell, square

**Snap**:
The placement grid granularity (1, 0.5, or 0.25).
_Avoid_: grid

**Parameter**:
A type-specific scalar — a stair's step count, or a wall's or arch's thickness.
_Avoid_: option, setting

**Slope**:
A wall's top gradient: 0 is flat, 1 is a full run-axis slope.
_Avoid_: incline, angle

**Tall variant**:
A height multiplier (0.5×, 1×, 1.5×, 2×) for level-changing primitives.
_Avoid_: height variant, size

### Rendering

**Projection**:
The 2:1 pixel-art isometric mapping from world space to screen space.
_Avoid_: camera, view

**Canonical frame**:
An object's un-rotated local coordinate frame.
_Avoid_: local frame, model space

**Ray**:
A per-pixel cast used to find the nearest surface.
_Avoid_: raycast

**Z-buffer**:
The per-pixel depth store; a larger depth is nearer.
_Avoid_: depth buffer

**Owner**:
Which object — or the floor, or nothing — won a pixel.
_Avoid_: hit, source

**Outline**:
A one-pixel line drawn where adjacent surfaces differ.
_Avoid_: edge, line, border

**Shading**:
How grey is assigned: shaded, height, silhouette, or blank.
_Avoid_: values, lighting

**Bands**:
The number of quantised grey steps (3–6) in shaded mode.
_Avoid_: value bands, steps

**Merge flush faces**:
Suppressing outlines between coplanar faces of different objects.
_Avoid_: merge coplanar

**Cutaway**:
Hiding everything above the active level.
_Avoid_: hide above, section

**Compose**:
Turning render buffers into pixels, in grey or colour.
_Avoid_: rasterise, draw

**Layer**:
A named RGBA plane for PSD export.
_Avoid_: plane, channel

**PSD**:
A layered Photoshop file written by the minimal encoder.
_Avoid_: photoshop file

### Placement and interaction

**Placement target**:
Where a new piece lands, as x, y, z.
_Avoid_: position, cursor

**Placement surface**:
Whether a piece lands on whatever you tap (stack) or on the active level's plane (plane).
_Avoid_: mode

**Placement style**:
Whether a drag stamps one piece per cell or stretches one piece (stamp or stretch).
_Avoid_: mode

**Tool**:
The active interaction: select, place, erase, or pan.
_Avoid_: mode

**Stroke**:
A drag that changes the document many times but undoes as one step.
_Avoid_: gesture, drag

**History**:
Undo and redo over whole-document snapshots.
_Avoid_: undo stack

**Draft**:
A localStorage copy of a scene, so an unreachable server never loses work.
_Avoid_: autosave, backup

### Combinatorics (JSON metadata)

**Combinatorics**:
The connectivity classes of a primitive, enumerated as center, edge, and corner.
_Avoid_: tileset, image combinatorics

**Combination class**:
A named connectivity class: single, end, straight, corner, tee, or center.
_Avoid_: class, combination

**Straight**:
The connectivity class with two opposite connections.
_Avoid_: edge

**iso-4 / iso-8**:
Connectivity schemes: four orthogonal neighbours, or eight including diagonals.
_Avoid_: scheme

**Blob rule**:
The iso-8 rule where a diagonal counts only when both flanking orthogonals are present.
_Avoid_: blob normalise

**Mask**:
The bitmask of which neighbours a tile touches.
_Avoid_: neighbour mask

**Adjacency**:
Which objects are face-adjacent and compatible.
_Avoid_: neighbours

**Join pairs**:
The set of connected owner pairs whose shared seam is suppressed.
_Avoid_: open faces

**Wall corner**:
Perpendicular walls meeting at a corner, unioned by a mitre post.
_Avoid_: corner, mitre

### Tileset (image combinatorics)

**Tileset**:
Discrete PNG block images, one per neighbour-match permutation, drawn over in Procreate and re-imported.
_Avoid_: combinatorics, sprite sheet

**Open-corner rule**:
The tileset rule where a diagonal matters only when both flanking orthogonals are absent.
_Avoid_: blob rule

**Config**:
One of the 47 open-corner neighbour configurations, id c00–c2f.
_Avoid_: configuration, permutation

**Template**:
A distinct primitive shape in a tileset: type, footprint, height, parameter, and slope.
_Avoid_: face, tileset face

**Sprite**:
One rendered PNG for a template and config.
_Avoid_: image, tile

**Manifest**:
The zip's manifest.json contract: configs, templates, and sprites.
_Avoid_: index

**Tileset reference**:
The small persisted reference (id and manifest); sprites live in IndexedDB.
_Avoid_: reference

**Tileset placement**:
How to paint one object from a sprite: image, anchor, and scale.
_Avoid_: placement

**Anchor**:
The screen position of the footprint's back corner at ground level.
_Avoid_: origin, pivot

### Colour

**Colour palette**:
An imported rampart palette: ordered colours from a shared shadow, through ramps dark to light, to a shared highlight.
_Avoid_: palette, swatches

**Rampart**:
The external app whose palette export Plinth consumes.
_Avoid_: ramp

**Colour ramp**:
A slice of palette slots used dark to light for one object.
_Avoid_: ramp, gradient

**Shared shadow / shared highlight**:
The palette's shared darkest and lightest anchors.
_Avoid_: shadow slot, highlight slot

**Swatch**:
A single colour entry in a palette.
_Avoid_: colour, chip

**Swatch use**:
Which palette slots participate, and which are shadow or highlight.
_Avoid_: usage

**Assign**:
How a ramp is chosen per object: cycle, by type, or by level.
_Avoid_: mapping

**Colour mode**:
Whether colour comes from ramps (positional) or bands (an explicit value-to-colour map).
_Avoid_: colour from

**Band colours**:
The explicit map from a value band index to a hex colour.
_Avoid_: value map

**Base colour**:
The PSD layer holding the coloured render beneath the greyscale trace layers.
_Avoid_: colour layer
