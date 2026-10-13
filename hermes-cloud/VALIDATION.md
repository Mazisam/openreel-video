# Validation — 0.2.0 (2026-10-13)

Base `d624bd5` (hermes-cloud 0.1.0) plus the analysis/QA patch. Executed locally with Node 24, Python 3, system FFmpeg:

- `npm run build` OK; **29 Node tests pass** (the original 18 plus analysis, QA, artifact route, caption style, loudnorm, fake-ASR plumbing).
- Analysis, render with caption style and two-pass loudnorm, and QA were run on real FFmpeg output; SAAM's end-to-end test drives this build over HTTP.
- Persian captions: libass shaping verified on rendered frames; mixed-direction caption uses an RLM prefix.

NOT RUN: Docker image build, Railway deploy, real speech recognition (model download blocked here; the plumbing is tested with a fake engine), real Railway memory/time under a large source, any model or Google call.

---

# Validation — 2026-10-12

Source: Augani/openreel-video c9340465e5d37e684cc25bdbe746c4ccd45e165c.

Executed in the development container: Node 24.19.0, Python 3.12, system FFmpeg.

- HeadlessHost bundle built successfully from actual upstream TypeScript.
- 18 Node tests passed, zero failures.
- 3 Python configuration-preservation tests passed.
- Real MP4: H.264 video, AAC audio, 320×180, 24fps, 2 seconds.
- Frame sampling verified red footage → blue timed overlay → red footage.
- Decoded audio was nonzero; subtitle pixels were visible.
- Official MCP SDK Client completed initialize/listTools/callTool over Streamable HTTP.
- API authentication, DNS/public-IP checks, media allowlist, atomic edit rollback, stale revisions, request deduplication, restart persistence, cancellation, and output cleanup were verified.
- Python files compiled; embedded console JavaScript syntax checked with Node.

Not executed: Docker image build (Docker unavailable), live Railway/Vercel deployment, live external HTTPS media import, browser UI visual test, provider/model/Google calls. No live render time or cloud bill estimate has been measured.

This is a supported-subset renderer, not parity with OpenReel's complete browser/GPU renderer. The main OpenReel web UI Export button has not been rewired; the included cloud console and Hermes MCP use the cloud renderer.
