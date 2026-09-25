# ADR-008: Define canonical V2 transform and crop geometry

- **Status:** Accepted for V2 POC
- **Date:** 25 September 2026

## Context

`TransformSchema` already carries position, scale, rotation, and anchor values, while `CropSchema` carries normalized bounds. Their units and application order were not specified. A backend must not invent project semantics from FFmpeg filter behavior.

## Decisions

- Crop is a normalized rectangle in source-image coordinates and is applied before fitting to the composition.
- The remaining image is aspect-preserving contain-fitted to the canonical canvas. Uncovered canvas space is black in the native V2 baseline.
- `scale` is a positive multiplier after contain-fit.
- `rotation` is clockwise degrees around the transformed clip center. Native FFmpeg maps this to the clockwise `rotate` filter angle described in the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#rotate).
- `anchorX` and `anchorY` are normalized canvas-space alignment values: `0` aligns to the start/top, `0.5` centers, and `1` aligns to the end/bottom within the available canvas gap.
- `x` and `y` are signed canvas-pixel offsets added after that alignment.
- `opacity` is applied to the clip before compositing. Audio gain is in dB and applies after trim/speed; clip mute or video-track mute produces silence.
- These are Replex semantics. A backend translates them; it does not define or store them.

## Consequences

- Planning and replay use the same units across native and future replaceable backends.
- Any change to these meanings requires a deliberate canonical-model decision and may require a project/contract version strategy; it cannot be introduced as a renderer-only adjustment.
- V2-203 remains a bounded baseline: one uploaded video clip without layers or transitions.
