# V2-601 motion backend spike

**Date:** 25 September 2026
**Decision:** **PARTIAL-GO** for two bounded presets on Replex's existing native FFmpeg render path. **NO-GO for adding Remotion to this POC.** This is a technical selection, not Gate D or creative approval.

## Decision

Implement a replaceable, typed `MotionBackend` boundary as specified in [ADR-002](../architecture/ADR-002-media-backends.md), with the existing native FFmpeg implementation as its initial POC backend, for:

- `camera-push`, a small deterministic push-in on a video clip;
- `title-reveal`, a bounded fade-in on a text layer.

Both are Replex-owned semantics. Canonical state will retain preset ID/version, typed bounded parameters, and target identity. The planner will lower these into a versioned frozen motion job; the backend will receive no `ProjectV2`, model-authored code, FFmpeg argv, or filtergraph. Keep `MediaBackend` and `MotionBackend` as separate replaceable boundaries; selecting FFmpeg here does not merge conventional media rendering with motion semantics. Preserve the existing media path for projects without motion. This decision does not authorize arbitrary React, JavaScript, WebGL, or filtergraph input.

The measured FFmpeg path is promising for a local POC, but the sample is too small to establish visual quality, broader platform behavior, color management, or cancellation. Gate D stays open until the implemented treatments receive human review.

## Candidates

| Candidate | Evidence | Decision |
|---|---|---|
| Replex-owned FFmpeg filter presets | A local FFmpeg 9.0.1 synthetic render combined `zoompan` with a timed `drawtext` reveal and audio. Two runs had identical output hashes. A ProRes 4444 intermediate retained transparent and nontransparent pixels. FFmpeg documents frame/time-based `zoompan` and animated `drawtext` expressions. | **Selected for bounded V2-602 work.** FFmpeg can implement the distinct `MotionBackend` boundary without a new runtime package. |
| Remotion fixed trusted compositions | Official docs describe frame-based compositions, local Player/Studio preview, frame rendering, cancellation/progress APIs, and alpha-capable output options. No Remotion package was installed or executed, so performance and repeatability are unmeasured. Its browser-bundler documentation warns that loaded project code is trusted code and is not a sandbox. | **Not adopted in this POC.** Reconsider if interactive browser preview or richer motion proves necessary and licensing/evaluation evidence justifies another backend. |

The selected FFmpeg implementation keeps motion inside the current Replex-owned semantic planner and verified render path while preserving the distinct `MotionBackend` boundary. Remotion remains a replaceable option for a later measured comparison; neither candidate owns canonical semantics.

## Local FFmpeg experiment

Environment: installed Gyan FFmpeg 9.0.1 full build on Windows. Its `-version` output reports `--enable-gpl --enable-version3` and GPLv3 for that build. This is a build-specific observation; it is not a claim about every FFmpeg build. Gyan's builds page also identifies its binaries as GPLv3. The spike did not redistribute the executable. [Gyan FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)

The fixture was FFmpeg `testsrc2`, 640 x 360 at 30 fps for 3 seconds, plus a 440 Hz sine input at 48 kHz. The filter chain applied a small center zoom with `zoompan` and a title fade with `drawtext`. The exact render shape was:

```text
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=3 -filter_complex "[0:v]zoompan=z='min(zoom+0.0009,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=640x360:fps=30,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='REPLEX':fontsize=34:fontcolor=white:box=1:boxcolor=0x101820@0.55:x=(w-text_w)/2:y=h*0.72:alpha='min(max((t-0.3)/0.8,0),1)'[v]" -map "[v]" -map 1:a -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -threads:v 1 -c:a aac -b:a 128k -ar 48000 -t 3 -movflags +faststart -y <output.mp4>
```

Two runs produced 514,016-byte files with the same SHA-256:

```text
9D40AFDF51AB8B2BF57D6AB177730A1A9DC50738D2BBC1D789303313C93F0395
```

The first/cold run took 1.322 seconds; the second/warm run took 0.619 seconds. These are anecdotal wall-clock timings from one Windows machine; hardware details and the timing method were not recorded, so they are not comparable or representative performance results. `ffprobe` reported H.264, 640 x 360, `yuv420p`, 30/1 fps, 3 seconds, and AAC mono at 48 kHz for 3 seconds. The output did not report color-space, transfer, or primaries tags.

A separate three-second title-only intermediate rendered to ProRes 4444 using `yuva444p10le`. `ffprobe` reported 640 x 360, 30/1 fps, 3 seconds, and `yuva444p12le`. Decoding one frame to RGBA produced 921,600 bytes; alpha ranged from 0 to 196, with 227,530 transparent pixels and 2,870 nontransparent pixels. The verification command was `ffmpeg -hide_banner -loglevel error -ss 1 -i title-alpha.mov -frames:v 1 -f rawvideo -pix_fmt rgba -y title-alpha-verified.rgba`. Its output SHA-256 was `9852632EEE365C0A063FDBBED1DD993122BE988FBC69DEC79F6910F6909C08A4`. This confirms alpha survives that local encoding/decoding path, not cross-version or cross-platform parity.

The first title attempt used `font='Arial'` and crashed with a missing Fontconfig configuration error (exit `-1073741819` / `0xC0000005`). Naming the font by explicit file path succeeded. Replex must continue using an authorized, hashed font file and must not rely on host font discovery.

## Evaluation against Replex needs

| Requirement | Result and limit |
|---|---|
| Deterministic inputs | **Supported in the experiment:** fixed test source, dimensions, fps, expressions, font file, and encoder settings. The production job still needs frozen preset values and font identity. |
| Repeat render | **Pass for one fixture/environment:** both MP4 runs had the same SHA-256. This does not prove cross-machine or cross-version bitwise equality. |
| Alpha/intermediate | **Pass for one local ProRes 4444 path:** nonzero and zero alpha decoded. Cross-platform codecs and final compositing parity remain untested. |
| Frame size/fps | **Pass for 640 x 360 at 30 fps.** Other canvas sizes and frame rates were not measured. |
| Color | **Unresolved:** the MP4 was `yuv420p`; FFprobe reported no color tags. The POC profile does not establish managed color behavior. |
| Audio | **Pass for a synthetic mono tone:** final AAC stream remained 48 kHz and 3 seconds. Multichannel music and Replex's full mix path were not benchmarked by this spike. |
| Cancellation | **Not measured in this spike.** Implementation must stay inside the existing Replex process ownership, staging, and cancellation path and add a cancellation regression check. |
| Performance | **Anecdotal single-machine wall-clock timings only** on a small 640 x 360, 3-second synthetic clip: 1.322 seconds cold and 0.619 seconds warm. Hardware and measurement method were not recorded; this is not comparable or representative 1080p performance evidence. |
| Local preview | Native output can use the existing verified preview render. This is not an interactive timeline preview. No browser UI work is included. |
| Replaceability/security | **Good architectural fit:** the planner owns semantics and emits a frozen, typed job. The implementation must generate every expression from fixed preset templates and bounded numbers; no raw filtergraph field is allowed. |

## Remotion license and adoption constraints

The official license page, last updated 24 September 2026, states that individuals and organizations of up to three people can use the Free License, including commercial use, subject to its terms. Organizations of four or more require a Company License; the Automators plan is listed at $0.01 per successful render with a $100/month minimum. The FAQ says Remotion is source-available under a proprietary license, permits generated compositions for users, and disallows users uploading arbitrary Remotion projects to the service. Replex's exact organization eligibility has not been verified. [Remotion pricing](https://convert.remotion.dev/docs/license/pricing), [Remotion license FAQ](https://convert.remotion.dev/docs/license/faq)

Remotion's API documentation lists Player/Studio preview, frame rendering, progress and cancellation APIs, and alpha-capable intermediate formats. Those are documented capabilities, not local measurements in this spike. The preview bundle documentation explicitly says it executes trusted code and is not a sandbox. A Remotion integration would therefore need to expose only Replex-owned preset components and typed parameters. [Player](https://www.remotion.dev/docs/player), [renderer API](https://www.remotion.dev/docs/renderer/render-media), [transparent videos](https://www.remotion.dev/docs/transparent-videos), [browser bundle security boundary](https://www.remotion.dev/docs/browser-bundler/create-browser-bundle-runtime)

This POC does not incur Remotion licensing or package cost because it does not adopt or run Remotion. If Replex later adopts it, verify the then-current license against organization size and deployment model before implementation; codec patent obligations are separate from Remotion's license.

## Gate and next work

**V2-601 result: PARTIAL-GO.** The bounded candidate list is `camera-push` and `title-reveal` (fade-in), behind the replaceable `MotionBackend` boundary, using native FFmpeg as its first implementation. V2-602 will implement `camera-push.v1` first; defer `title-reveal` because the required alpha-layer composition path has only synthetic evidence and would expand the first implementation. Keep `MediaBackend` distinct as required by ADR-002. Do not implement Remotion, 3D scenes, arbitrary component code, or additional presets in this POC.

## V2-602 implementation candidate

As of 25 September 2026, the `feat/v2-602-camera-push` branch implements the bounded `camera-push.v1` candidate. Canonical state is optional and absent when unused. The reducer upserts a strict target/version/strength operation; the frozen `MotionExecutionJobV1` and replaceable `MotionBackend` stay distinct from the final composition backend. V3 composition receives only a separate executor-issued motion handle, while canonical source audio follows its regular trim/speed/gain/mute path. Existing media job versions, service-contract v1, V1 rendering, and media-only semantic hashes are unchanged.

The native backend requires host-configured trusted direct FFmpeg/FFprobe binaries. Wrappers are unsupported: execution uses `shell: false`, cancellation kills and drains the direct child, and the POC does not claim general process-tree ownership. The intermediate remains in private staging only through final composition and is removed afterward. A small receipt at `.replex-evidence/motion/receipts/<artifact-id>/verification.json` remains readable; it binds the source asset ID/hash, target clip, preset/version/typed strength, source revision/hash, motion job hash, output hash/probe, backend, and FFmpeg version. Successful conversational results return typed motion execution summaries to the host; model-facing tool results contain only the verified final preview.

The FFmpeg-backed fixture demonstrates a visible 6% centered push, deterministic repeat output in the same environment, preserved source SAR, silent intermediate verification, final H.264/AAC composition, and a same-thread strength follow-up. A synthetic V3 composition with non-default crop, 1.25x scale, and 0.75 opacity checks the asymmetric green marker at chosen output coordinates with tolerant RGB assertions. The test also binds motion result pins to the executor-issued handle and V3 job, binds final verification to that job, and checks preview pins and committed output identity in both conversational turns. The retained local output is 55,076 bytes (SHA-256 `123E88E0239AA87C3948504E891CA3FB94844E3C7B864E93281CF3C69DEDB083`; FFprobe: H.264 320 x 180 at 24 fps, AAC, 2.0 seconds). The artifact remains only in the local temporary review workspace and is not committed.

`npm run build` passed. The latest author-run serial suite passed 38 files / 290 tests with zero skips in 248.70 seconds using direct FFmpeg/FFprobe 9.0.1; the pixel-order check, lineage assertions, motion conversation, final render, receipt, and cancellation checks all ran. `git diff --check` passed. An independent validator passed the earlier candidate at `2a710d9` with 38 files / 290 tests in 280.42 seconds; that result predates the test-only pixel and lineage assertions, and no post-change independent result is claimed. No GitHub CI result is claimed. Phase 7/local PR-E has not started. This local synthetic evidence does not establish cross-platform bitwise repeatability, live-provider quality, or production readiness.

Gate D remains open. A small human review cohort must judge the treatment on a representative software-product video before the motion quality gate can pass. Do not treat the spike's timings, test fixtures, or one retained sample as a quality verdict.

## Primary sources

- [FFmpeg filter documentation: `zoompan`](https://ffmpeg.org/ffmpeg-filters.html#zoompan)
- [FFmpeg filter documentation: `drawtext`](https://ffmpeg.org/ffmpeg-filters.html#drawtext)
- [FFmpeg CLI progress interface](https://ffmpeg.org/ffmpeg.html#toc-Progress)
- [Gyan Windows FFmpeg builds and licensing](https://www.gyan.dev/ffmpeg/builds/)
- [Remotion pricing](https://convert.remotion.dev/docs/license/pricing)
- [Remotion license FAQ](https://convert.remotion.dev/docs/license/faq)
- [Remotion Player](https://www.remotion.dev/docs/player)
- [Remotion render API](https://www.remotion.dev/docs/renderer/render-media)
- [Remotion transparency](https://www.remotion.dev/docs/transparent-videos)
- [Remotion browser bundle trusted-code warning](https://www.remotion.dev/docs/browser-bundler/create-browser-bundle-runtime)
