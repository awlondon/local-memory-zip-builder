# Local Memory ZIP Builder

A GitHub Pages-compatible browser app that converts a `.txt`, `.html`, or `.json` document into a deterministic `local_memory/` retrieval archive and downloads it as a ZIP.

## What it does

- Runs fully client-side (HTML/CSS/vanilla JS)
- Accepts `.txt`, `.html/.htm`, and `.json` input
- Uses a Web Worker for heavy processing
- Splits oversized inputs into deterministic source parts and processes them sequentially
- Normalizes conversation-style JSON exports into ordered transcript turns before chunking when explicit roles can be recovered
- Sessionizes and chunks text using deterministic heuristics
- Preserves speaker identity across blocks, sessions, chunks, symbolic streams, and textpack records
- Extracts recurring concepts and concept/chunk/session links
- Builds graph and index artifacts as JSON/JSONL
- Generates optional symbolic stream files per session
- Emits a root-level core-obsessions graph artifact for interactive archive browsing
- Packages everything with JSZip

## Output layout

The ZIP contains:

```text
core-obsessions-graph.html
core-obsessions-graph.css
core-obsessions-graph.js
core-obsessions-graph.data.json
core-obsessions-agent-README.md
local_memory/
  manifest/
    corpus.json
    sessions.jsonl
    chunks.jsonl
    generation_report.json
  raw/
    input_full.txt / input_full.html / input_full.json
    input_parts/input_part_000001.html  (for large inputs)
    input_parts/input_part_000002.html
    sess_000001.txt
    ...
  symbolic/
    sess_000001.stream.jsonl
    ...
  concepts/
    concepts_000001.jsonl
    ...
  graph/
    edges_000001.jsonl
    concept_stats.jsonl
  chunks/
    chunk_text_part_000001.jsonl
    chunk_text_part_000002.jsonl
  textpack/
    textpack_manifest.json
    textpack_000001.index.jsonl
    textpack_000001.bin
  index/
    concept_index.json
    session_index.json
    keyword_index.json
    chunk_text_shards.json
    textpack_shards.json
  instructions/
    README.txt
```

The root `core-obsessions-graph.*` bundle is a companion artifact that opens in a browser after unzipping. It highlights the archive's strongest recurring concepts, links each selected obsession to specific session shards, and can reconstruct raw thread text through `symbolic/` plus `textpack/`. A companion `core-obsessions-agent-README.md` is also included as a fallback recipe for an LLM agent to regenerate or refine the graph directly from `local_memory/`.

Chunk, session, symbolic, and textpack metadata now include speaker-aware fields such as `speaker_role`, `speaker_label`, `speaker_inference_source`, `speaker_confidence`, `turn_index`, and `turn_role`. The pipeline prefers explicit labels like `User:` / `Assistant:` first, then metadata-style role markers, then inferred turn alternation and session defaults when labels are weak or missing.

For `.json` inputs, the builder now tries to preserve conversation structure instead of flattening everything into path/value noise. Chat-style exports with `mapping`, `messages`, `author.role`, and `content.parts` fields are rendered into ordered transcript turns such as `User:` / `Assistant:` / `Tool:` before sessionization. When a JSON slice is incomplete, the fallback keeps content-bearing fields and role markers while filtering high-noise metadata paths.

## Run locally

1. Serve the repository with a static server (or use GitHub Pages).
2. Open `index.html` in the browser.
3. Upload a `.txt`, `.html`, or `.json` file and click **Generate ZIP**.
4. Download and unzip the archive.

## GitHub Pages deployment

A workflow is already included at `.github/workflows/deploy-pages.yml`.

1. Push this repo to GitHub with `main` as the default branch.
2. In GitHub: **Settings -> Pages -> Build and deployment -> Source**, select **GitHub Actions**.
3. Push to `main` (or run the workflow manually from **Actions**).
4. After it completes, your site will be available at `https://<your-user>.github.io/<repo-name>/`.

## Notes on determinism and limits

- The pipeline is deterministic for the same file content + file metadata + settings.
- ZIP entries use a fixed timestamp for stable output ordering.
- Browser memory constraints still apply for very large files.
- Large files are split and processed part-by-part to reduce memory spikes.
- In low-memory mode for very large inputs, symbolic streams and per-session raw shard files may be skipped to prevent browser OOM. For extremely large files, raw input parts may also be omitted from the ZIP.
- Full chunk text is still preserved in `local_memory/chunks/chunk_text_part_*.jsonl` for grounded retrieval.
- `speaker_confidence` is numeric and should be read together with `speaker_inference_source`; explicit labels and metadata markers are stronger than turn-based guesses.
- When a chunk spans multiple speakers, `speaker_role` becomes `mixed` and `speaker_sequence_preview` shows the order that was preserved.
- Conversation headings are structural only and do not count as conversational turns; `turn_index` and `turn_count` reflect actual message ownership.
- Extremely large outputs can still take significant time during ZIP generation.
- No external AI APIs or backend services are required.

## JSZip

The app tries to load JSZip from `./vendor/jszip.min.js` first, then falls back to CDN:
`https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`.

For strict offline usage, place JSZip at `vendor/jszip.min.js`.
