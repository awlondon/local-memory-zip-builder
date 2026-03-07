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
  padNumber,
  toKeywordMap
} from "./utils.js";

const PROCESSING_PART_BYTES = {
  text: 32 * 1024 * 1024,
  html: 20 * 1024 * 1024,
  json: 12 * 1024 * 1024
};

const RAW_SHARD_COMPRESS_STORE_BYTES = 25 * 1024 * 1024;

self.addEventListener("message", (event) => {
  if (event.data?.type !== "start") {
    return;
  }

  runPipeline(event.data).catch((error) => {
    const message = error instanceof Error ? error.message : "Worker failed";
    const stack = error instanceof Error && typeof error.stack === "string"
      ? error.stack.split("\\n").slice(0, 4).join(" | ")
      : null;

    self.postMessage({
      type: "error",
      error: stack ? `${message} (${stack})` : message
    });
  });
});

async function runPipeline({ file, settings }) {
  const warnings = [];
  const limits = {
    browser_memory_bound: true,
    max_tested_text_size_mb: 120,
    processing_mode: "single"
  };

  if (!file) {
    throw new Error("No file provided.");
  }

  const inputFormat = detectInputFormat(file.name, file.type);
  const bytes = file.size || 0;
  const partByteSize = PROCESSING_PART_BYTES[inputFormat] || PROCESSING_PART_BYTES.text;
  const partPlan = buildPartPlan(bytes, partByteSize);

  limits.processing_part_size_mb = roundMb(partByteSize);
  limits.processing_part_count = partPlan.length;
  limits.processing_mode = partPlan.length > 1 ? "sequential_parts" : "single";

  const pushWarning = (warning) => {
    if (!warning || warnings.includes(warning)) {
      return;
    }
    warnings.push(warning);
    self.postMessage({ type: "warning", warning });
  };

  if (partPlan.length > 1) {
    pushWarning(
      `Input file split into ${partPlan.length} parts (~${roundMb(partByteSize)} MB each) and processed sequentially.`
    );
  }

  const allSessions = [];
  const allChunks = [];
  const allConcepts = [];
  const allEdges = [];
  const allConceptStats = [];
  const allSymbolicFiles = [];

  const counters = {
    session: 1,
    chunk: 1,
    concept: 1
  };

  let previousLastSessionId = null;
  let previousLastChunkId = null;
  let globalOffsetBase = 0;

  for (let i = 0; i < partPlan.length; i += 1) {
    const part = partPlan[i];
    const partLabel = `part ${i + 1}/${partPlan.length}`;

    emitProgress("reading", aggregatePartProgress(i, partPlan.length, 0), `Reading ${partLabel}...`);
    const rawText = await readTextSlice(file, part.start, part.end, (fraction) => {
      emitProgress("reading", aggregatePartProgress(i, partPlan.length, fraction), `Reading ${partLabel}...`);
    });

    const retrievalText = normalizeInputForRetrieval(rawText, inputFormat, pushWarning);
    if (!retrievalText) {
      pushWarning(`Skipped ${partLabel} because no retrievable text remained after normalization.`);
      continue;
    }

    emitProgress("segmenting", aggregatePartProgress(i, partPlan.length, 0), `Segmenting ${partLabel}...`);
    const blocks = parseTextToBlocks(retrievalText, (fraction) => {
      emitProgress(
        "segmenting",
        aggregatePartProgress(i, partPlan.length, fraction * 0.45),
        `Parsing structural blocks for ${partLabel}...`
      );
    });

    const partSessions = sessionizeBlocks(blocks, retrievalText, settings, (fraction) => {
      emitProgress(
        "segmenting",
        aggregatePartProgress(i, partPlan.length, 0.45 + fraction * 0.55),
        `Applying session boundaries for ${partLabel}...`
      );
    });

    emitProgress("chunking", aggregatePartProgress(i, partPlan.length, 0), `Chunking ${partLabel}...`);
    const partChunks = chunkSessions(partSessions, settings, (fraction) => {
      emitProgress(
        "chunking",
        aggregatePartProgress(i, partPlan.length, fraction),
        `Building coherent chunks for ${partLabel}...`
      );
    });

    shiftOffsets(partSessions, partChunks, globalOffsetBase);
    globalOffsetBase += retrievalText.length + 2;

    emitProgress("concept_extraction", aggregatePartProgress(i, partPlan.length, 0), `Extracting concepts for ${partLabel}...`);
    const extracted = extractConcepts(partChunks, settings, (fraction) => {
      emitProgress(
        "concept_extraction",
        aggregatePartProgress(i, partPlan.length, fraction),
        `Scoring concepts for ${partLabel}...`
      );
    });

    const remapped = remapPartEntities(
      {
        sessions: partSessions,
        chunks: partChunks,
        concepts: extracted.concepts,
        chunkConcepts: extracted.chunkConcepts
      },
      counters
    );

    attachSessionConcepts(remapped.sessions, remapped.chunks, remapped.chunkConcepts);

    emitProgress("graph_build", aggregatePartProgress(i, partPlan.length, 0), `Building graph for ${partLabel}...`);
    const partGraph = buildGraphArtifacts(
      {
        sessions: remapped.sessions,
        chunks: remapped.chunks,
        concepts: remapped.concepts,
        chunkConcepts: remapped.chunkConcepts
      },
      (fraction) => {
        emitProgress(
          "graph_build",
          aggregatePartProgress(i, partPlan.length, fraction),
          `Computing graph edges for ${partLabel}...`
        );
      }
    );

    if (previousLastChunkId && remapped.chunks.length) {
      allEdges.push({ src: previousLastChunkId, dst: remapped.chunks[0].chunk_id, type: "adjacent_to", weight: 1 });
    }
    if (previousLastSessionId && remapped.sessions.length) {
      allEdges.push({ src: previousLastSessionId, dst: remapped.sessions[0].session_id, type: "continues", weight: 0.55 });
    }

    if (remapped.sessions.length) {
      previousLastSessionId = remapped.sessions[remapped.sessions.length - 1].session_id;
    }
    if (remapped.chunks.length) {
      previousLastChunkId = remapped.chunks[remapped.chunks.length - 1].chunk_id;
    }

    appendAll(allSessions, remapped.sessions);
    appendAll(allChunks, remapped.chunks);
    appendAll(allConcepts, remapped.concepts);
    appendAll(allEdges, partGraph.edges);
    appendAll(allConceptStats, partGraph.conceptStats);

    if (settings.includeSymbolic) {
      emitProgress("symbolic_streams", aggregatePartProgress(i, partPlan.length, 0), `Generating symbolic stream for ${partLabel}...`);
      const partSymbolic = buildSymbolicStreams(remapped.sessions, remapped.chunks, (fraction) => {
        emitProgress(
          "symbolic_streams",
          aggregatePartProgress(i, partPlan.length, fraction),
          `Mapping glyph families for ${partLabel}...`
        );
      });
      appendAll(allSymbolicFiles, partSymbolic);
    }

    await pause();
  }

  if (!allChunks.length) {
    throw new Error("No retrievable text found after parsing input.");
  }

  emitProgress("reading", 1, "Input fully read.");
  emitProgress("segmenting", 1, "Sessions ready.");
  emitProgress("chunking", 1, "Chunks ready.");
  emitProgress("concept_extraction", 1, "Concept extraction complete.");
  emitProgress("graph_build", 1, "Graph artifacts complete.");
  emitProgress("symbolic_streams", 1, settings.includeSymbolic ? "Symbolic streams complete." : "Symbolic streams disabled.");

  emitProgress("finalize", 0, "Preparing output files...");

  const files = [];

  const sessionManifestJsonl = buildSessionManifest(allSessions);
  const chunkManifestJsonl = buildChunkManifest(allChunks);

  const corpusManifest = buildCorpusManifest(file.name, bytes, settings, {
    sessions: allSessions.length,
    chunks: allChunks.length,
    concepts: allConcepts.length,
    edges: allEdges.length
  });

  corpusManifest.input_format = inputFormat;
  corpusManifest.source_parts = {
    count: partPlan.length,
    bytes_per_part: partByteSize
  };

  const deterministicTimestamp = deterministicTimestampFromFile(file);
  const estimatedDurationMs = estimateDeterministicDurationMs(bytes, allSessions.length, allChunks.length);

  const generationReport = buildGenerationReport({
    inputFilename: file.name,
    bytesProcessed: bytes,
    generationTimestamp: deterministicTimestamp,
    totalSessions: allSessions.length,
    totalChunks: allChunks.length,
    totalConcepts: allConcepts.length,
    totalEdges: allEdges.length,
    estimatedDurationMs,
    warnings,
    limits
  });

  generationReport.source_parts = {
    count: partPlan.length,
    bytes_per_part: partByteSize,
    format: inputFormat
  };

  files.push({ path: "local_memory/manifest/corpus.json", content: JSON.stringify(corpusManifest, null, 2) });
  files.push({ path: "local_memory/manifest/sessions.jsonl", content: sessionManifestJsonl });
  files.push({ path: "local_memory/manifest/chunks.jsonl", content: chunkManifestJsonl });
  files.push({ path: "local_memory/manifest/generation_report.json", content: JSON.stringify(generationReport, null, 2) });

  if (settings.includeRaw !== false) {
    if (partPlan.length > 1) {
      files.push({
        path: "local_memory/raw/_original_split_note.txt",
        content: `Original source file was split into ${partPlan.length} raw shards for deterministic sequential processing.`
      });
    } else {
      files.push({
        path: "local_memory/raw/_original_file_note.txt",
        content: "Original source file is included as input_full.* in this folder."
      });
    }

    for (const session of allSessions) {
      files.push({
        path: `local_memory/raw/${session.session_id}.txt`,
        content: session.text
      });
    }
  }

  const conceptShards = createShards(allConcepts, "concepts", "local_memory/concepts", 2000);
  appendAll(files, conceptShards);

  const edgeShards = createShards(allEdges, "edges", "local_memory/graph", 4000);
  appendAll(files, edgeShards);
  files.push({ path: "local_memory/graph/concept_stats.jsonl", content: asJsonl(allConceptStats) });

  files.push({
    path: "local_memory/index/concept_index.json",
    content: JSON.stringify(buildConceptIndex(allConcepts), null, 2)
  });
  files.push({
    path: "local_memory/index/session_index.json",
    content: JSON.stringify(buildSessionIndex(allSessions), null, 2)
  });
  files.push({
    path: "local_memory/index/keyword_index.json",
    content: JSON.stringify(toKeywordMap(allConcepts), null, 2)
  });

  if (settings.includeSymbolic) {
    appendAll(files, allSymbolicFiles);
  }

  files.push({
    path: "local_memory/instructions/README.txt",
    content: buildInstructionsFile()
  });

  emitProgress("finalize", 1, "Output files ready.");

  const downloadName = makeDownloadName(file.name);

  self.postMessage({
    type: "complete",
    files,
    warnings,
    downloadName,
    report: generationReport,
    rawFilePlan: settings.includeRaw !== false ? buildRawFilePlan(partPlan, file.name, inputFormat) : []
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

function buildPartPlan(totalBytes, partByteSize) {
  const safePartSize = Math.max(1024 * 1024, partByteSize || 8 * 1024 * 1024);
  const parts = [];

  if (totalBytes <= 0) {
    parts.push({ index: 0, start: 0, end: 0 });
    return parts;
  }

  let index = 0;
  for (let start = 0; start < totalBytes; start += safePartSize) {
    const end = Math.min(totalBytes, start + safePartSize);
    parts.push({ index, start, end });
    index += 1;
  }

  return parts;
}

function buildRawFilePlan(partPlan, fileName, inputFormat) {
  const extension = inputFormat === "html" ? "html" : inputFormat === "json" ? "json" : inferTextExtension(fileName);

  if (partPlan.length <= 1) {
    const single = partPlan[0] || { start: 0, end: 0 };
    return [{
      path: rawInputShardPath(fileName, inputFormat),
      start: single.start,
      end: single.end,
      compression: single.end - single.start > RAW_SHARD_COMPRESS_STORE_BYTES ? "STORE" : "DEFLATE"
    }];
  }

  return partPlan.map((part, i) => ({
    path: `local_memory/raw/input_parts/input_part_${padNumber(i + 1)}.${extension}`,
    start: part.start,
    end: part.end,
    compression: part.end - part.start > RAW_SHARD_COMPRESS_STORE_BYTES ? "STORE" : "DEFLATE"
  }));
}

function inferTextExtension(fileName) {
  const lower = (fileName || "").toLowerCase();
  if (lower.endsWith(".md")) {
    return "md";
  }
  if (lower.endsWith(".log")) {
    return "log";
  }
  return "txt";
}

async function readTextSlice(file, start, end, onProgress) {
  const slice = file.slice(start, end);
  const text = await slice.text();
  if (typeof onProgress === "function") {
    onProgress(1);
  }
  return text;
}

function remapPartEntities(payload, counters) {
  const sessions = payload.sessions.map((session) => ({ ...session, chunk_ids: [...session.chunk_ids], concept_ids: [...session.concept_ids] }));
  const chunks = payload.chunks.map((chunk) => ({ ...chunk }));
  const concepts = payload.concepts.map((concept) => ({ ...concept, aliases: [...concept.aliases], chunk_ids: [...concept.chunk_ids] }));
  const chunkConcepts = payload.chunkConcepts;

  const sessionIdMap = new Map();
  for (const session of sessions) {
    const oldId = session.session_id;
    const newId = makeGlobalId("sess", counters.session++);
    sessionIdMap.set(oldId, newId);
  }

  const chunkIdMap = new Map();
  for (const chunk of chunks) {
    const oldId = chunk.chunk_id;
    const newId = makeGlobalId("chunk", counters.chunk++);
    chunkIdMap.set(oldId, newId);
  }

  const conceptIdMap = new Map();
  for (const concept of concepts) {
    const oldId = concept.concept_id;
    const newId = makeGlobalId("concept", counters.concept++);
    conceptIdMap.set(oldId, newId);
  }

  for (const session of sessions) {
    const oldId = session.session_id;
    session.session_id = sessionIdMap.get(oldId);
    session.chunk_ids = session.chunk_ids.map((id) => chunkIdMap.get(id)).filter(Boolean);
    session.concept_ids = session.concept_ids.map((id) => conceptIdMap.get(id)).filter(Boolean);
  }

  for (const chunk of chunks) {
    const oldChunkId = chunk.chunk_id;
    chunk.chunk_id = chunkIdMap.get(oldChunkId);
    chunk.session_id = sessionIdMap.get(chunk.session_id) || chunk.session_id;
  }

  for (const concept of concepts) {
    const oldConceptId = concept.concept_id;
    concept.concept_id = conceptIdMap.get(oldConceptId);
    concept.chunk_ids = concept.chunk_ids.map((id) => chunkIdMap.get(id)).filter(Boolean);
  }

  const remappedChunkConcepts = Object.create(null);
  for (const [oldChunkId, links] of Object.entries(chunkConcepts)) {
    const newChunkId = chunkIdMap.get(oldChunkId);
    if (!newChunkId) {
      continue;
    }

    remappedChunkConcepts[newChunkId] = links
      .map((link) => ({
        concept_id: conceptIdMap.get(link.concept_id),
        score: link.score
      }))
      .filter((link) => Boolean(link.concept_id));
  }

  return {
    sessions,
    chunks,
    concepts,
    chunkConcepts: remappedChunkConcepts
  };
}

function shiftOffsets(sessions, chunks, baseOffset) {
  if (!baseOffset) {
    return;
  }

  for (const session of sessions) {
    session.start_offset += baseOffset;
    session.end_offset += baseOffset;
  }

  for (const chunk of chunks) {
    chunk.start_offset += baseOffset;
    chunk.end_offset += baseOffset;
  }
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

function makeGlobalId(prefix, number) {
  return `${prefix}_${padNumber(number)}`;
}

function makeDownloadName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9\-_]+/g, "_");
  return `${base || "local_memory"}_local_memory.zip`;
}

function aggregatePartProgress(partIndex, partCount, innerProgress) {
  const base = partIndex / Math.max(1, partCount);
  const width = 1 / Math.max(1, partCount);
  const inner = Math.max(0, Math.min(1, innerProgress || 0));
  return Math.max(0, Math.min(1, base + width * inner));
}

function roundMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}


