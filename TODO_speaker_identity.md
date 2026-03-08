# TODO: Speaker Identity In Generated Databases

Goal: make generated `local_memory/` databases preserve and expose speaker identity so downstream retrieval defaults can answer "human or AI?" using explicit labels first, then inferred turn-making when labels are weak or missing.

## Problem Summary

Current pipeline behavior:

- `src/parser.js` extracts only a weak `speaker_label` from `Name: ...` text patterns.
- `src/sessionizer.js` uses `speaker_label` only to help boundary scoring.
- `src/chunker.js` drops speaker information from emitted chunks.
- `src/schemas.js` does not include speaker identity fields in manifests.
- `src/worker.js` writes chunk text shards and manifests without speaker identity.

Result:

- generated databases preserve `kind`, but not `speaker_role`
- retrieval agents can tell a passage is a `request`, `fact`, `quote`, etc., but cannot reliably tell whether it came from the human, AI, system, or tool
- identity has to be re-inferred from raw text later, which is brittle and expensive

## Target Output Model

Every block/chunk/session written to the archive should support these fields:

- `speaker_role`
  - enum: `human`, `ai`, `system`, `tool`, `unknown`
- `speaker_label`
  - raw visible label when present, for example `User`, `Assistant`, `Altair`, `Ankaa`
- `speaker_inference_source`
  - enum: `explicit_label`, `metadata_pattern`, `turn_alternation`, `session_default`, `unknown`
- `speaker_confidence`
  - numeric `0..1` or enum `high|medium|low`
- `turn_index`
  - monotonically increasing turn number within a session where turn structure can be inferred
- `turn_role`
  - same enum as `speaker_role`, but scoped to turn ownership

Recommended optional rollups:

- `session_speakers`
- `speaker_sequence_preview`
- `dominant_human_label`
- `dominant_ai_label`

## Default Inference Rules

System defaults should look for `human` vs `ai` using this order:

1. Explicit speaker labels in text
2. Metadata-like role markers in normalized text
3. Stable alternation by turn after the first confident attribution
4. Session-level defaults if one side is established and the next turn alternates cleanly
5. `unknown` if the passage is genuinely ambiguous

Suggested explicit mappings:

- `user`, `human`, `person`, `customer`, `client`, `altair` -> `human`
- `assistant`, `ai`, `model`, `ankaa`, `chatgpt`, `gpt` -> `ai`
- `system` -> `system`
- `tool`, `browser`, `search`, `function`, `shell`, `mcp` -> `tool`

Suggested turn-making heuristic:

- once a session has one confident `human` turn and one confident `ai` turn, alternate by turn boundary unless contradicted by a stronger explicit marker
- do not alternate inside code blocks or quoted metadata dumps
- reset confidence downward after long unlabeled runs or structural discontinuities

## Concrete File Tasks

### 1. `src/parser.js`

Add stronger block-level identity extraction.

Tasks:

- expand `SPEAKER_PATTERN` beyond `Name:` style labels
- detect common role headers:
  - `User:`
  - `Assistant:`
  - `System:`
  - `Tool:`
  - `Human:`
  - `AI:`
- detect metadata-like role lines when the input is normalized JSON/text, for example:
  - `message.author.role: user`
  - `message.author.role: assistant`
  - `author.role: tool`
- emit new block fields:
  - `speaker_label`
  - `speaker_role`
  - `speaker_inference_source`
  - `speaker_confidence`
- preserve whether the speaker came from direct text vs inferred metadata

Implementation note:

- do not rely only on `speaker_label`; normalize immediately into `speaker_role`

### 2. `src/sessionizer.js`

Preserve and improve turn structure instead of using speaker hints only for boundaries.

Tasks:

- add speaker change as a stronger boundary cue than it is now
- compute session-local `turn_index`
- collapse consecutive same-speaker blocks into a turn model before chunking, or at minimum annotate blocks with inferred turn ids
- persist session-level rollups:
  - `session_speakers`
  - `dominant_human_label`
  - `dominant_ai_label`

Implementation note:

- if speaker identity is weak but alternating patterns are strong, annotate as inferred rather than explicit

### 3. `src/chunker.js`

Do not discard identity at chunk construction time.

Tasks:

- carry forward block speaker fields into chunk units
- avoid merging two different speakers into one chunk unless the chunk is explicitly a quoted exchange or metadata artifact
- emit chunk fields:
  - `speaker_role`
  - `speaker_label`
  - `speaker_inference_source`
  - `speaker_confidence`
  - `turn_index`
  - `turn_role`
- add chunk boundary preference when a speaker switch occurs

Implementation note:

- if a chunk spans multiple speakers, emit:
  - `speaker_role: mixed`
  - `speaker_sequence_preview`
  - `turn_count`

If `mixed` is not desirable, split earlier.

### 4. `src/schemas.js`

Expose identity in written database manifests.

Tasks:

- add speaker fields to `buildChunkManifest`
- add session-level speaker summaries to `buildSessionManifest`
- update `buildSessionIndex` so retrieval agents can quickly filter:
  - human-only sessions
  - ai-heavy sessions
  - mixed sessions

Recommended chunk manifest additions:

- `speaker_role`
- `speaker_label`
- `speaker_inference_source`
- `speaker_confidence`
- `turn_index`
- `turn_role`

### 5. `src/worker.js`

Write identity through all emitted artifacts, not just manifests.

Tasks:

- include speaker fields in `manifest/chunks.jsonl`
- include speaker fields in `chunks/chunk_text_part_*.jsonl`
- include session speaker summaries in `manifest/sessions.jsonl`
- make sure textpack auxiliary metadata can reconstruct speaker identity without reopening raw text

Important:

- downstream retrieval should not have to rediscover identity from `text`
- speaker identity should survive low-memory mode too

### 6. `src/textpack.js`

Preserve identity through reconstruction-oriented storage.

Tasks:

- add speaker metadata to textpack auxiliary records or shard manifests
- ensure round-tripped reconstructed chunks retain:
  - `speaker_role`
  - `speaker_label`
  - `turn_index`

### 7. `README.md`

Document the new identity model.

Tasks:

- describe speaker-aware outputs
- explain confidence and inference semantics
- explain that defaults prioritize explicit labels over inferred turn alternation

### 8. Retrieval Compatibility Instructions

Update generated instruction text in `src/schemas.js -> buildInstructionsFile()`.

Add guidance such as:

- prefer `speaker_role` before re-inferring identity from raw text
- default to `human` vs `ai` using `speaker_inference_source` and `speaker_confidence`
- only reopen raw shards when `speaker_role == unknown` or `mixed`

## Suggested Heuristic Strategy

Implement a small identity resolver:

1. `explicit label resolver`
2. `metadata role resolver`
3. `turn alternation resolver`
4. `session default resolver`

Scoring example:

- explicit `User:` or `Assistant:` = `0.98`
- metadata `message.author.role: user` = `0.95`
- known alias like `Altair:` or `Ankaa:` = `0.9`
- turn alternation after confident pair = `0.7`
- session default fallback = `0.55`
- otherwise `unknown`

## Acceptance Criteria

The work is done when:

- `manifest/chunks.jsonl` includes stable speaker fields
- `chunks/chunk_text_part_*.jsonl` includes stable speaker fields
- `manifest/sessions.jsonl` includes speaker summaries
- speaker identity survives low-memory mode and textpack mode
- a downstream retrieval agent can answer "human or AI?" without scraping raw text for most passages
- unlabeled conversational transcripts still produce sensible `turn_index` and `speaker_role` values by inferred turn-making

## Manual Verification Cases

Create fixture inputs for:

1. Explicit chat transcript
   - `User: ...`
   - `Assistant: ...`

2. Alias-based transcript
   - `Altair: ...`
   - `Ankaa: ...`

3. Metadata-style normalized transcript
   - `message.author.role: user`
   - `message.author.role: assistant`

4. Plain alternating transcript with no labels
   - verify fallback turn inference

5. Mixed artifact dump
   - system/tool/user content all present
   - verify `system`, `tool`, and `human` are not collapsed together

## Non-Goals

- perfect speaker diarization from arbitrary prose
- reconstructing identity from heavily damaged or context-free fragments with false certainty
- forcing a binary human/AI assignment when the data is actually ambiguous

Default should be:

- correct when explicit
- useful when inferred
- honest when unknown
