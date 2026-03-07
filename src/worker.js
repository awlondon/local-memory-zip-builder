import { parseTextToBlocks } from "./parser.js";
import { sessionizeBlocks } from "./sessionizer.js";
import { chunkSessions } from "./chunker.js";
import { extractConcepts } from "./concepts.js";
import { buildGraphArtifacts } from "./graph.js";
import { buildSymbolicStreams } from "./symbolic.js";
import { detectInputFormat, normalizeInputForRetrieval, rawInputShardPath } from "./ingest.js";
import {
  buildChunkManifest,
  buildConceptIndex,
  buildCorpusManifest,
  buildGenerationReport,
  buildInstructionsFile,
  buildSessionIndex,
  buildSessionManifest
} from "./schemas.js";
import {
  asJsonl,
  createShards,
  deterministicTimestampFromFile,
  estimateDeterministicDurationMs,
  toKeywordMap
} from "./utils.js";

const RETRIEVAL_BYTE_LIMITS = {
  text: 48 * 1024 * 1024,
  html: 24 * 1024 * 1024,
  json: 16 * 1024 * 1024
};

const MAX_ORIGINAL_RAW_INCLUDE_BYTES = 180 * 1024 * 1024;

self.addEventListener("message", (event) => {
  if (event.data?.type !== "start") {
    return;
  }

  runPipeline(event.data).catch((error) => {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Worker failed"
    });
  });
});

async function runPipeline({ file, settings }) {
  const warnings = [];
  const limits = {
    browser_memory_bound: true,
    max_tested_text_size_mb: 120,
    retrieval_window_limit_mb: 0
  };

  if (!file) {
    throw new Error("No file provided.");
  }

  const inputFormat = detectInputFormat(file.name, file.type);
  const bytes = file.size || 0;

  const pushWarning = (warning) => {
    if (!warning || warnings.includes(warning)) {
      return;
    }
    warnings.push(warning);
    self.postMessage({ type: "warning", warning });
  };

  if (bytes > 80 * 1024 * 1024) {
    pushWarning("Large file detected. Processing uses a bounded retrieval window to avoid browser memory failures.");
  }

  emitProgress("reading", 0, "Reading input file...");

  const retrievalLimitBytes = RETRIEVAL_BYTE_LIMITS[inputFormat] || RETRIEVAL_BYTE_LIMITS.text;
  limits.retrieval_window_limit_mb = Math.round((retrievalLimitBytes / (1024 * 1024)) * 10) / 10;

  const retrievalRead = await readTextWindowFromFile(file, retrievalLimitBytes, (fraction) => {
    emitProgress("reading", fraction * 0.88, "Reading retrieval window...");
  });

  if (retrievalRead.truncated) {
    const limitMb = (retrievalLimitBytes / (1024 * 1024)).toFixed(0);
    pushWarning(
      `Retrieval analysis used the first ${limitMb} MB only (${inputFormat} window). Split very large inputs for full-coverage indexing.`
    );
  }

  const retrievalText = normalizeInputForRetrieval(retrievalRead.text, inputFormat, pushWarning);
  emitProgress("reading", 1, "Input normalized for retrieval.");

  if (!retrievalText) {
    throw new Error("No retrievable text found after parsing input.");
  }

  emitProgress("segmenting", 0, "Segmenting sessions...");
  const blocks = parseTextToBlocks(retrievalText, (fraction) => {
    emitProgress("segmenting", fraction * 0.45, "Parsing structural blocks...");
  });

  const sessions = sessionizeBlocks(blocks, retrievalText, settings, (fraction) => {
    emitProgress("segmenting", 0.45 + fraction * 0.55, "Applying session boundary heuristics...");
  });
  emitProgress("segmenting", 1, "Sessions ready.");

  emitProgress("chunking", 0, "Chunking sessions...");
  const chunks = chunkSessions(sessions, settings, (fraction) => {
    emitProgress("chunking", fraction, "Building coherent retrieval chunks...");
  });
  emitProgress("chunking", 1, "Chunks ready.");

  emitProgress("concept_extraction", 0, "Extracting recurring concepts...");
  const { concepts, chunkConcepts } = extractConcepts(chunks, settings, (fraction) => {
    emitProgress("concept_extraction", fraction, "Scoring concept candidates...");
  });
  emitProgress("concept_extraction", 1, "Concept extraction complete.");

  attachSessionConcepts(sessions, chunks, chunkConcepts);

  emitProgress("graph_build", 0, "Building graph relations...");
  const { edges, conceptStats } = buildGraphArtifacts(
    { sessions, chunks, concepts, chunkConcepts },
    (fraction) => {
      emitProgress("graph_build", fraction, "Computing graph edges...");
    }
  );
  emitProgress("graph_build", 1, "Graph artifacts complete.");

  let symbolicFiles = [];
  if (settings.includeSymbolic) {
    emitProgress("symbolic_streams", 0, "Generating symbolic streams...");
    symbolicFiles = buildSymbolicStreams(sessions, chunks, (fraction) => {
      emitProgress("symbolic_streams", fraction, "Mapping chunks to glyph families...");
    });
    emitProgress("symbolic_streams", 1, "Symbolic streams complete.");
  } else {
    emitProgress("symbolic_streams", 1, "Symbolic streams disabled.");
  }

  emitProgress("finalize", 0, "Preparing output files...");

  const files = [];

  const sessionManifestJsonl = buildSessionManifest(sessions);
  const chunkManifestJsonl = buildChunkManifest(chunks);

  const corpusManifest = buildCorpusManifest(file.name, bytes, settings, {
    sessions: sessions.length,
    chunks: chunks.length,
    concepts: concepts.length,
    edges: edges.length
  });

  corpusManifest.input_format = inputFormat;
  corpusManifest.retrieval_window_bytes = retrievalLimitBytes;
  corpusManifest.retrieval_window_truncated = retrievalRead.truncated;

  const deterministicTimestamp = deterministicTimestampFromFile(file);
  const estimatedDurationMs = estimateDeterministicDurationMs(bytes, sessions.length, chunks.length);

  const generationReport = buildGenerationReport({
    inputFilename: file.name,
    bytesProcessed: bytes,
    generationTimestamp: deterministicTimestamp,
    totalSessions: sessions.length,
    totalChunks: chunks.length,
    totalConcepts: concepts.length,
    totalEdges: edges.length,
    estimatedDurationMs,
    warnings,
    limits
  });

  generationReport.retrieval_window = {
    input_format: inputFormat,
    byte_limit: retrievalLimitBytes,
    bytes_loaded: retrievalRead.bytesLoaded,
    truncated: retrievalRead.truncated
  };

  files.push({ path: "local_memory/manifest/corpus.json", content: JSON.stringify(corpusManifest, null, 2) });
  files.push({ path: "local_memory/manifest/sessions.jsonl", content: sessionManifestJsonl });
  files.push({ path: "local_memory/manifest/chunks.jsonl", content: chunkManifestJsonl });
  files.push({ path: "local_memory/manifest/generation_report.json", content: JSON.stringify(generationReport, null, 2) });

  if (settings.includeRaw !== false) {
    if (bytes > MAX_ORIGINAL_RAW_INCLUDE_BYTES) {
      pushWarning(
        `Original source file not embedded in ZIP because it exceeds ${(MAX_ORIGINAL_RAW_INCLUDE_BYTES / (1024 * 1024)).toFixed(0)} MB. ` +
          "Session shards and retrieval manifests are included; split source files for full lossless packaging."
      );
    } else {
      files.push({
        path: "local_memory/raw/_original_file_note.txt",
        content: "Original source file is included as input_full.* in this folder."
      });
    }

    for (const session of sessions) {
      files.push({
        path: `local_memory/raw/${session.session_id}.txt`,
        content: session.text
      });
    }
  }

  const conceptShards = createShards(concepts, "concepts", "local_memory/concepts", 2000);
  files.push(...conceptShards);

  const edgeShards = createShards(edges, "edges", "local_memory/graph", 4000);
  files.push(...edgeShards);
  files.push({ path: "local_memory/graph/concept_stats.jsonl", content: asJsonl(conceptStats) });

  files.push({
    path: "local_memory/index/concept_index.json",
    content: JSON.stringify(buildConceptIndex(concepts), null, 2)
  });
  files.push({
    path: "local_memory/index/session_index.json",
    content: JSON.stringify(buildSessionIndex(sessions), null, 2)
  });
  files.push({
    path: "local_memory/index/keyword_index.json",
    content: JSON.stringify(toKeywordMap(concepts), null, 2)
  });

  files.push(...symbolicFiles);

  files.push({
    path: "local_memory/instructions/README.txt",
    content: buildInstructionsFile()
  });

  emitProgress("finalize", 1, "Output files ready.");

  const downloadName = makeDownloadName(file.name);

  const rawInputPath = settings.includeRaw !== false && bytes <= MAX_ORIGINAL_RAW_INCLUDE_BYTES
    ? rawInputShardPath(file.name, inputFormat)
    : null;

  self.postMessage({
    type: "complete",
    files,
    warnings,
    downloadName,
    report: generationReport,
    rawInputPath
  });
}

function emitProgress(stage, stageProgress, status) {
  self.postMessage({
    type: "progress",
    stage,
    stageProgress,
    status
  });
}

async function readTextWindowFromFile(file, maxBytes, onProgress) {
  const safeMax = Math.max(1, maxBytes || file.size || 1);

  const streamFn = file.stream?.bind(file);
  if (!streamFn) {
    const blob = file.size > safeMax ? file.slice(0, safeMax) : file;
    const text = await blob.text();
    if (typeof onProgress === "function") {
      onProgress(1);
    }
    return {
      text,
      bytesLoaded: blob.size,
      truncated: file.size > blob.size
    };
  }

  const reader = streamFn().getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks = [];
  let loadedBytes = 0;
  let collectedBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    loadedBytes += value.byteLength;

    if (collectedBytes < safeMax) {
      const remaining = safeMax - collectedBytes;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      collectedBytes += slice.byteLength;
      chunks.push(decoder.decode(slice, { stream: true }));

      if (slice.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    } else {
      truncated = true;
      break;
    }

    if (typeof onProgress === "function") {
      onProgress(Math.min(1, loadedBytes / Math.max(1, file.size || loadedBytes)));
    }
  }

  chunks.push(decoder.decode());

  if (!truncated && file.size > collectedBytes) {
    truncated = true;
  }

  if (typeof onProgress === "function") {
    onProgress(truncated ? Math.min(1, collectedBytes / Math.max(1, file.size || collectedBytes)) : 1);
  }

  return {
    text: chunks.join(""),
    bytesLoaded: collectedBytes,
    truncated
  };
}

function attachSessionConcepts(sessions, chunks, chunkConcepts) {
  const sessionMap = new Map(sessions.map((session) => [session.session_id, session]));
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));

  const sessionConceptMap = new Map(sessions.map((session) => [session.session_id, new Set()]));

  for (const [chunkId, links] of Object.entries(chunkConcepts)) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) {
      continue;
    }

    const conceptSet = sessionConceptMap.get(chunk.session_id);
    for (const link of links) {
      conceptSet.add(link.concept_id);
    }
  }

  for (const [sessionId, conceptSet] of sessionConceptMap.entries()) {
    const session = sessionMap.get(sessionId);
    session.concept_ids = [...conceptSet].sort((a, b) => a.localeCompare(b));
  }
}

function makeDownloadName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9\-_]+/g, "_");
  return `${base || "local_memory"}_local_memory.zip`;
}
