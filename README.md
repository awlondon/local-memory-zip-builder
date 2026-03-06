# Local Memory ZIP Builder

A GitHub Pages-compatible browser app that converts a large `.txt` document into a deterministic `local_memory/` retrieval archive and downloads it as a ZIP.

## What it does

- Runs fully client-side (HTML/CSS/vanilla JS)
- Uses a Web Worker for heavy processing
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
    input_full.txt
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
3. Upload a text file and click **Generate ZIP**.
4. Download and unzip the archive.

## GitHub Pages

This project is static. You can deploy it directly with GitHub Pages from the repository root.

## Notes on determinism and limits

- The pipeline is deterministic for the same file content + file metadata + settings.
- ZIP entries use a fixed timestamp for stable output ordering.
- Browser memory constraints still apply for very large files.
- No external AI APIs or backend services are required.

## JSZip

The app tries to load JSZip from `./vendor/jszip.min.js` first, then falls back to CDN:
`https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`.

For strict offline usage, place JSZip at `vendor/jszip.min.js`.

