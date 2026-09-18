# ADR-001: Media composition is canonical

- **Status:** Accepted for V2; not implemented
- **Date:** 19 September 2026

## Context

V1 requires every scene to reference a browser capture, scene key, action IDs, and checkpoint. That accurately models Release Replay but cannot represent uploaded video, images, or audio without fake browser metadata.

## Decision

The canonical project is a Replex-owned media composition. Browser capture and uploaded files both become immutable `MediaAsset` records. Clips reference `assetId`; browser provenance remains mandatory only for `browser_capture` assets. One reducer, revision chain, verification model, and render protocol serve all sources.

V1 projects load through a compatibility adapter and migrate only through an explicit command that preserves the original. See [`REPLEX_V2.md`](REPLEX_V2.md#5-v1-compatibility-and-migration).

## Consequences

- Mixed-media projects and normal uploads no longer require invented browser fields.
- Selective recapture remains available wherever browser provenance exists.
- Project validation becomes source-agnostic at the composition level and source-specific at the asset provenance boundary.
- The schema owns a constrained timeline, not a universal editing graph.

## Rejected alternatives

- **Separate browser and upload products:** duplicates editing, revisions, and rendering and makes mixed projects fragile.
- **Make all media look like captures:** corrupts provenance semantics.
- **Adopt a renderer/editor project format:** couples durable state to replaceable execution technology.
