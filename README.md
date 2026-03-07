# Local Memory ZIP Builder

A GitHub Pages-compatible browser app that converts a `.txt`, `.html`, or `.json` document into a deterministic `local_memory/` retrieval archive and downloads it as a ZIP.

## What it does

- Runs fully client-side (HTML/CSS/vanilla JS)
- Accepts `.txt`, `.html/.htm`, and `.json` input
- Uses a Web Worker for heavy processing
- Splits oversized inputs into deterministic source parts and processes them sequentially
- Sessionizes and chunks text using deterministic heuristics
- Extracts recurring concepts and concept/chunk/session links
- Builds graph and index artifacts as JSON/JSONL
- Generates optional symbolic stream files per session
- Packages everything with JSZip

## Output layout

The ZIP contains:

```text
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
  index/
    concept_index.json
    session_index.json
    keyword_index.json
  instructions/
    README.txt
```

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
- Large files are split and processed part-by-part to reduce memory spikes.`r`n- In low-memory mode for very large inputs, symbolic streams and per-session raw shard files may be skipped to prevent browser OOM. For extremely large files, raw input parts may also be omitted from the ZIP.
- Extremely large outputs can still take significant time during ZIP generation.
- No external AI APIs or backend services are required.

## JSZip

The app tries to load JSZip from `./vendor/jszip.min.js` first, then falls back to CDN:
`https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`.

For strict offline usage, place JSZip at `vendor/jszip.min.js`.



