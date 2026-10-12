# Two combinatorics systems coexist: JSON metadata and image tileset

Plinth ships two independent "combinatorics" systems. The original design classified a primitive's connectivity as JSON metadata — center/edge/corner classes, iso-4/iso-8 schemes, and the blob rule — and exported it alongside the scene. The requester's intent later shifted to image combinatorics: discrete PNG block images, one per neighbour-match permutation, drawn over in Procreate and re-imported as a tileset. We kept both rather than replacing the JSON path, because the JSON metadata still serves programmatic consumers while the image tileset is the primary authoring path. The two systems use different neighbour rules — the blob rule for JSON, the open-corner rule for the tileset — and must not be conflated.

## Status

Accepted.

## Considered Options

- **Replace the JSON metadata with the image tileset.** Rejected: the JSON path has programmatic consumers, and the tileset is an authoring convenience, not a superset.
- **Keep both, but unify the neighbour rule.** Rejected: the blob rule and the open-corner rule encode genuinely different connectivity semantics; forcing one would change output for existing consumers.

## Consequences

- Two neighbour rules must be maintained and documented separately; the glossary disambiguates "Combinatorics" (JSON) from "Tileset" (images).
- The spec marks §2/§3 as superseded by §10, but the code intentionally carries both — a future reader should not "clean up" the JSON path without first checking for consumers.
