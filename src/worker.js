import { parseTextToBlocks } from "./parser.js";
import { sessionizeBlocks } from "./sessionizer.js";
import { chunkSessions } from "./chunker.js";
import { extractConcepts } from "./concepts.js";
import { buildGraphArtifacts } from "./graph.js";
import { buildSymbolicStreams } from "./symbolic.js";
import { buildTextpackBundle } from "./textpack.js";
import { buildCoreObsessionsArtifact } from "./core-obsessions-artifact.js?v=20260309-01";
import { buildSymbolLibrary } from "./symbol-library.js?v=20260309-01";
import { buildQueryProtocol } from "./query.js?v=20260309-01";
import { detectInputFormat, normalizeInputForRetrieval, rawInputShardPath } from "./ingest.js?v=20260308-02";
import {
  buildChunkManifest,
  buildConceptIndex,
  buildCorpusManifest,
  buildGenerationReport,
  buildInstructionsFile,
  buildSessionIndex,
  buildSessionManifest
} from "./schemas.js?v=20260309-01";
import {
  asJsonl,
  createShards,
  deterministicTimestampFromFile,
  estimateDeterministicDurationMs,
  padNumber,
  toKeywordMap
} from "./utils.js";

const PART_BYTES = {
  text: 32 * 1024 * 1024,
  html: 20 * 1024 * 1024,
  json: 12 * 1024 * 1024
};

const RAW_SHARD_COMPRESS_STORE_BYTES = 25 * 1024 * 1024;
const CHUNK_PREVIEW_MAX = 260;
const FILE_BATCH_MAX_ITEMS = 24;
const FILE_BATCH_MAX_BYTES = 2 * 1024 * 1024;
const LARGE_STRING_BLOB_THRESHOLD = 256 * 1024;

self.addEventListener("message", (event) => {
  if (event.data?.type !== "start") {
    return;
  }

  runPipeline(event.data).catch((error) => {
    const message = error instanceof Error ? error.message : "Worker failed";
    const stack = error instanceof Error && typeof error.stack === "string"
      ? error.stack.split("\n").slice(0, 4).join(" | ")
      : null;

    self.postMessage({
      type: "error",
      error: stack ? `${message} (${stack})` : message
    });
  });
});

async function runPipeline({ file, settings }) {
  if (!file) {
    throw new Error("No file provided.");
  }

  const warnings = [];
  const limits = {
    browser_memory_bound: true,
    processing_mode: "single"
  };

  const inputFormat = detectInputFormat(file.name, file.type);
  const bytes = file.size || 0;

  const pushWarning = (warning) => {
    if (!warning || warnings.includes(warning)) {
      return;
    }
    warnings.push(warning);
    self.postMessage({ type: "warning", warning });
  };

  const partByteSize = PART_BYTES[inputFormat] || PART_BYTES.text;
  const partPlan = buildPartPlan(bytes, partByteSize);
  limits.processing_part_size_mb = roundMb(partByteSize);
  limits.processing_part_count = partPlan.length;
  limits.processing_mode = partPlan.length > 1 ? "sequential_parts" : "single";

  if (partPlan.length > 1) {
    pushWarning(
      `Input file split into ${partPlan.length} parts (~${roundMb(partByteSize)} MB each) and processed sequentially.`
    );
  }

  const LARGE_INPUT_BYTES = 800 * 1024 * 1024;
  const isLargeInput = bytes > LARGE_INPUT_BYTES;

  let includeRaw = settings.includeRaw === true;
  let includeLegacyChunkText = settings.includeLegacyChunkText === true;
  const includeSymbolic = settings.includeSymbolic !== false;
  const includeTextpack = true;

  if (isLargeInput && includeRaw) {
    includeRaw = false;
    pushWarning("Raw input file inclusion disabled for very large inputs (>800 MB) to stay within browser memory limits. Textpack preserves all text for reconstruction.");
  }

  if (isLargeInput && includeLegacyChunkText) {
    includeLegacyChunkText = false;
    pushWarning("Legacy chunk text shards disabled for very large inputs (>800 MB). Textpack encoding provides equivalent reversible text storage.");
  }

  if (settings.includeTextpack === false) {
    pushWarning("Textpack output is required for reversible reconstruction in this build and will remain enabled.");
  }

  if (includeLegacyChunkText) {
    pushWarning("Legacy chunk text shards are retained for one compatibility release alongside textpack output.");
  }

  const pendingFiles = [];
  let pendingFileBytes = 0;

  const flushPendingFiles = () => {
    if (!pendingFiles.length) {
      return;
    }

    const batch = pendingFiles.splice(0, pendingFiles.length);
    pendingFileBytes = 0;
    self.postMessage({ type: "file_batch", files: batch });
  };

  const enqueueFile = (entry) => {
    const normalizedEntry = normalizeFileEntry(entry);
    pendingFiles.push(normalizedEntry);
    pendingFileBytes += estimateContentSize(normalizedEntry.content);

    if (pendingFiles.length >= FILE_BATCH_MAX_ITEMS || pendingFileBytes >= FILE_BATCH_MAX_BYTES) {
      flushPendingFiles();
    }
  };

  const allSessions = [];
  const allFullChunks = [];
  const manifestChunks = [];
  const allConcepts = [];
  const allChunkConcepts = Object.create(null);
  const allEdges = [];
  const chunkTextShardPaths = [];
  const textpackShardPaths = [];
  const textpackShardEntries = [];

  const textpackChunkTextRefs = Object.create(null);
  const textpackChunkPhraseMap = Object.create(null);
  const textpackArtifacts = [];
  const textpackValidations = [];
  const textpackStats = { raw_text_bytes: 0, textpack_literal_bytes: 0, lexicon_entries: 0, template_entries: 0, artifact_versions: 0 };
  let lastTextpackManifestPath = null;

  const counters = {
    session: 1,
    chunk: 1,
    concept: 1
  };

  let previousLastSessionId = null;
  let previousLastChunkId = null;
  let globalOffsetBase = 0;
  let totalSessionsProcessed = 0;
  let totalChunksProcessed = 0;
  let totalConceptsProcessed = 0;

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
    totalSessionsProcessed += remapped.sessions.length;
    totalChunksProcessed += remapped.chunks.length;
    totalConceptsProcessed += remapped.concepts.length;

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

    if (includeRaw) {
      for (const session of remapped.sessions) {
        enqueueFile({
          path: `local_memory/raw/${session.session_id}.txt`,
          content: session.text
        });
      }
    }

    if (includeLegacyChunkText) {
      const chunkTextShardPath = `local_memory/chunks/chunk_text_part_${padNumber(i + 1)}.jsonl`;
      const chunkTextRecords = [];
      for (const chunk of remapped.chunks) {
        chunkTextRecords.push({
          chunk_id: chunk.chunk_id,
          session_id: chunk.session_id,
          seq_in_session: chunk.seq_in_session,
          start_offset: chunk.start_offset,
          end_offset: chunk.end_offset,
          kind: chunk.kind,
          artifact_type: chunk.artifact_type || null,
          speaker_role: chunk.speaker_role || "unknown",
          speaker_label: chunk.speaker_label || null,
          speaker_inference_source: chunk.speaker_inference_source || "unknown",
          speaker_confidence: chunk.speaker_confidence || 0,
          turn_index: Number.isFinite(chunk.turn_index) ? chunk.turn_index : null,
          turn_role: chunk.turn_role || null,
          turn_count: chunk.turn_count || 1,
          speaker_sequence_preview: chunk.speaker_sequence_preview || "",
          text: chunk.text
        });
      }

      enqueueFile({ path: chunkTextShardPath, content: buildJsonlPayload(chunkTextRecords) });
      chunkTextShardPaths.push(chunkTextShardPath);
    }

    for (const session of remapped.sessions) {
      const lightweightSession = {
        session_id: session.session_id,
        title: session.title,
        start_offset: session.start_offset,
        end_offset: session.end_offset,
        chunk_ids: session.chunk_ids,
        concept_ids: session.concept_ids,
        turn_count: session.turn_count || 0,
        speaker_profile: session.speaker_profile || "unknown",
        session_speakers: session.session_speakers || [],
        speaker_sequence_preview: session.speaker_sequence_preview || "",
        dominant_human_label: session.dominant_human_label || null,
        dominant_ai_label: session.dominant_ai_label || null,
        speaker_role_counts: session.speaker_role_counts || null,
        human_turn_count: session.human_turn_count || 0,
        ai_turn_count: session.ai_turn_count || 0,
        system_turn_count: session.system_turn_count || 0,
        tool_turn_count: session.tool_turn_count || 0,
        unknown_turn_count: session.unknown_turn_count || 0,
        ai_turn_ratio: session.ai_turn_ratio || 0
      };

      allSessions.push(lightweightSession);
    }

    // ── Per-part textpack encoding (before accumulating chunks) ──
    if (includeTextpack) {
      const partBundleId = i + 1;
      const multiPart = partPlan.length > 1;
      const partChunkConcepts = Object.create(null);
      for (const chunk of remapped.chunks) {
        if (remapped.chunkConcepts[chunk.chunk_id]) {
          partChunkConcepts[chunk.chunk_id] = remapped.chunkConcepts[chunk.chunk_id];
        }
      }

      const bundle = buildTextpackBundle(remapped.chunks, partChunkConcepts, {
        bundleId: partBundleId,
        enableDeltaEncoding: settings.enableDeltaEncoding !== false,
        forceShardScopedAuxPaths: multiPart,
        onArtifactProgress: (fraction) => {
          emitProgress("artifact_promotion", aggregatePartProgress(i, partPlan.length, fraction), "Promoting structured artifacts...");
        },
        onEncodingProgress: (fraction) => {
          emitProgress("textpack_build", aggregatePartProgress(i, partPlan.length, fraction), `Encoding textpack part ${partLabel}...`);
        }
      });

      for (const fileEntry of bundle.files) {
        enqueueFile(fileEntry);
      }
      flushPendingFiles();

      textpackShardPaths.push(...bundle.shardPaths);
      textpackShardEntries.push(...bundle.manifest.shards.map((shard) => ({
        ...shard,
        lexicon_path: bundle.manifest.dictionary.lexicon_path,
        templates_path: bundle.manifest.dictionary.templates_path,
        manifest_path: bundle.manifestPath
      })));
      Object.assign(textpackChunkTextRefs, bundle.chunkTextRefs);
      Object.assign(textpackChunkPhraseMap, bundle.chunkPhraseMap);
      textpackArtifacts.push(...bundle.artifacts);
      textpackValidations.push(bundle.validation);
      textpackStats.raw_text_bytes += bundle.stats.raw_text_bytes;
      textpackStats.textpack_literal_bytes += bundle.stats.textpack_literal_bytes;
      textpackStats.lexicon_entries += bundle.stats.lexicon_entries;
      textpackStats.template_entries += bundle.stats.template_entries;
      textpackStats.artifact_versions += bundle.stats.artifact_versions;
      lastTextpackManifestPath = bundle.manifestPath;
    }

    // ── Trim chunk text after textpack captures it, then accumulate ──
    const TEXT_TRIM_LIMIT = 1200;
    for (const chunk of remapped.chunks) {
      if (chunk.text.length > TEXT_TRIM_LIMIT) {
        chunk.text = chunk.text.slice(0, TEXT_TRIM_LIMIT);
      }

      allFullChunks.push(chunk);

      manifestChunks.push({
        chunk_id: chunk.chunk_id,
        session_id: chunk.session_id,
        seq_in_session: chunk.seq_in_session,
        start_offset: chunk.start_offset,
        end_offset: chunk.end_offset,
        kind: chunk.kind,
        text_preview: makePreview(chunk.text),
        artifact_type: chunk.artifact_type || null,
        artifact_label: chunk.artifact_label || null,
        speaker_role: chunk.speaker_role || "unknown",
        speaker_label: chunk.speaker_label || null,
        speaker_inference_source: chunk.speaker_inference_source || "unknown",
        speaker_confidence: chunk.speaker_confidence || 0,
        turn_index: Number.isFinite(chunk.turn_index) ? chunk.turn_index : null,
        turn_role: chunk.turn_role || null,
        turn_count: chunk.turn_count || 1,
        speaker_sequence_preview: chunk.speaker_sequence_preview || "",
        text_ref: null
      });
    }

    for (const concept of remapped.concepts) {
      allConcepts.push(concept);
    }

    for (const [chunkId, links] of Object.entries(remapped.chunkConcepts)) {
      allChunkConcepts[chunkId] = links;
    }

    await pause();
  }

  if (!totalChunksProcessed) {
    throw new Error("No retrievable text found after parsing input.");
  }

  emitProgress("artifact_promotion", 1, "Structured artifacts promoted.");
  emitProgress("textpack_build", 1, includeTextpack ? "Textpack payloads encoded." : "Textpack disabled.");
  emitProgress("textpack_validate", 1, includeTextpack ? "Textpack reconstruction validated." : "Textpack validation skipped.");

  const textpackValidationSummaries = textpackValidations.length ? textpackValidations : [];
  const textpackStatsSummaries = textpackStats.raw_text_bytes > 0 ? [textpackStats] : [];
  let totalArtifactVersionsProcessed = textpackArtifacts.length;
  let artifactVersions = textpackArtifacts;

  for (const manifestChunk of manifestChunks) {
    if (textpackChunkTextRefs[manifestChunk.chunk_id]) {
      manifestChunk.text_ref = textpackChunkTextRefs[manifestChunk.chunk_id];
    } else if (includeLegacyChunkText) {
      manifestChunk.text_ref = { mode: "legacy_chunk_text", shard: "local_memory/chunks", record: manifestChunk.chunk_id };
    }
  }

  emitProgress("graph_build", 0, "Building graph artifacts...");
  const globalGraph = buildGraphArtifacts(
    {
      sessions: allSessions,
      chunks: allFullChunks,
      concepts: allConcepts,
      chunkConcepts: allChunkConcepts,
      artifacts: textpackArtifacts
    },
    (fraction) => emitProgress("graph_build", fraction, "Building graph artifacts...")
  );

  for (const edge of globalGraph.edges) {
    allEdges.push(edge);
  }

  const symbolLibrary = buildSymbolLibrary(allConcepts, allChunkConcepts, allEdges);

  emitProgress("symbolic_streams", 0, "Generating symbolic streams...");
  if (includeSymbolic) {
    const symbolicFiles = buildSymbolicStreams(
      allSessions,
      allFullChunks,
      {
        chunkConcepts: allChunkConcepts,
        chunkPhraseMap: textpackChunkPhraseMap,
        chunkTextRefs: textpackChunkTextRefs,
        artifacts: textpackArtifacts,
        conceptToSymbol: symbolLibrary.conceptToSymbol
      },
      (fraction) => emitProgress("symbolic_streams", fraction, "Generating symbolic streams...")
    );

    for (const fileEntry of symbolicFiles) {
      enqueueFile(fileEntry);
    }
  }
  emitProgress("symbolic_streams", 1, includeSymbolic ? "Symbolic streams complete." : "Symbolic streams disabled.");

  // ── Release large data structures no longer needed ──
  allFullChunks.length = 0;
  for (const key of Object.keys(textpackChunkPhraseMap)) {
    delete textpackChunkPhraseMap[key];
  }
  for (const key of Object.keys(textpackChunkTextRefs)) {
    delete textpackChunkTextRefs[key];
  }
  textpackArtifacts.length = 0;

  emitProgress("finalize", 0, "Preparing output files...");

  const corpusManifest = buildCorpusManifest(file.name, bytes, settings, {
    sessions: totalSessionsProcessed,
    chunks: totalChunksProcessed,
    concepts: totalConceptsProcessed,
    edges: allEdges.length,
    artifact_versions: totalArtifactVersionsProcessed
  });
  corpusManifest.input_format = inputFormat;
  corpusManifest.source_parts = {
    count: partPlan.length,
    bytes_per_part: partByteSize
  };

  const deterministicTimestamp = deterministicTimestampFromFile(file);
  const estimatedDurationMs = estimateDeterministicDurationMs(bytes, allSessions.length, manifestChunks.length);

  const generationReport = buildGenerationReport({
    inputFilename: file.name,
    bytesProcessed: bytes,
    generationTimestamp: deterministicTimestamp,
    totalSessions: totalSessionsProcessed,
    totalChunks: totalChunksProcessed,
    totalConcepts: totalConceptsProcessed,
    totalEdges: allEdges.length,
    totalArtifactVersions: totalArtifactVersionsProcessed,
    estimatedDurationMs,
    warnings,
    limits,
    textpack: includeTextpack && textpackStatsSummaries.length
      ? {
        enabled: true,
        mode: "per_part",
        validation: summarizeTextpackValidation(textpackValidationSummaries),
        stats: summarizeTextpackStats(textpackStatsSummaries)
      }
      : { enabled: false }
  });

  generationReport.source_parts = {
    count: partPlan.length,
    bytes_per_part: partByteSize,
    format: inputFormat
  };

  const textpackStatsSummary = summarizeTextpackStats(textpackStatsSummaries);
  if (textpackStatsSummary.raw_text_bytes > 0 && textpackStatsSummary.textpack_literal_bytes > 0) {
    generationReport.compression = {
      raw_text_bytes: textpackStatsSummary.raw_text_bytes,
      textpack_literal_bytes: textpackStatsSummary.textpack_literal_bytes,
      compression_ratio: Number((textpackStatsSummary.raw_text_bytes / textpackStatsSummary.textpack_literal_bytes).toFixed(2))
    };
  }

  generationReport.symbol_library = symbolLibrary.capacity;

  enqueueFile({ path: "local_memory/manifest/corpus.json", content: JSON.stringify(corpusManifest, null, 2) });
  enqueueFile({ path: "local_memory/manifest/sessions.jsonl", content: buildSessionManifest(allSessions) });
  enqueueFile({ path: "local_memory/manifest/chunks.jsonl", content: buildChunkManifest(manifestChunks) });
  enqueueFile({ path: "local_memory/manifest/generation_report.json", content: JSON.stringify(generationReport, null, 2) });

  if (artifactVersions.length) {
    enqueueFile({ path: "local_memory/manifest/artifacts.jsonl", content: asJsonl(artifactVersions) });
  }

  if (includeRaw) {
    if (partPlan.length > 1) {
      enqueueFile({
        path: "local_memory/raw/_original_split_note.txt",
        content: `Original source file was split into ${partPlan.length} raw shards for deterministic sequential processing.`
      });
    } else {
      enqueueFile({
        path: "local_memory/raw/_original_file_note.txt",
        content: "Original source file is included as input_full.* in this folder."
      });
    }
  }

  const conceptShards = createShards(allConcepts, "concepts", "local_memory/concepts", 2000);
  for (const shard of conceptShards) {
    enqueueFile(shard);
  }

  const edgeShards = createShards(allEdges, "edges", "local_memory/graph", 4000);
  for (const shard of edgeShards) {
    enqueueFile(shard);
  }
  enqueueFile({ path: "local_memory/graph/concept_stats.jsonl", content: asJsonl(globalGraph.conceptStats) });

  enqueueFile({
    path: "local_memory/index/concept_index.json",
    content: JSON.stringify(buildConceptIndex(allConcepts), null, 2)
  });
  enqueueFile({
    path: "local_memory/index/session_index.json",
    content: JSON.stringify(buildSessionIndex(allSessions), null, 2)
  });
  enqueueFile({
    path: "local_memory/index/keyword_index.json",
    content: JSON.stringify(toKeywordMap(allConcepts), null, 2)
  });
  enqueueFile({
    path: "local_memory/index/chunk_text_shards.json",
    content: JSON.stringify(chunkTextShardPaths, null, 2)
  });
  enqueueFile({
    path: "local_memory/index/textpack_shards.json",
    content: JSON.stringify(textpackShardPaths, null, 2)
  });

  if (symbolLibrary.symbols.length) {
    enqueueFile({
      path: "local_memory/symbolic/symbol_library.json",
      content: JSON.stringify({
        version: 1,
        capacity: symbolLibrary.capacity,
        symbols: symbolLibrary.symbols
      }, null, 2)
    });
  }

  const queryProtocol = buildQueryProtocol({
    concepts: allConcepts,
    edges: allEdges,
    symbols: symbolLibrary.symbols,
    conceptToSymbol: symbolLibrary.conceptToSymbol,
    sessions: allSessions,
    totalChunks: totalChunksProcessed,
    rawTextBytes: bytes,
    archiveBytes: generationReport.compression?.textpack_literal_bytes || 0
  });
  enqueueFile({
    path: "local_memory/index/query_protocol.json",
    content: JSON.stringify(queryProtocol, null, 2)
  });

  enqueueFile({
    path: "local_memory/instructions/README.txt",
    content: buildInstructionsFile()
  });

  const coreObsessionArtifactFiles = buildCoreObsessionsArtifact({
    inputFileName: file.name,
    sessions: allSessions,
    concepts: allConcepts,
    chunks: allFullChunks,
    symbolicEnabled: includeSymbolic
  });

  for (const fileEntry of coreObsessionArtifactFiles) {
    enqueueFile(fileEntry);
  }

  emitProgress("finalize", 1, "Output files ready.");

  flushPendingFiles();

  self.postMessage({
    type: "complete",
    warnings,
    downloadName: makeDownloadName(file.name),
    report: generationReport,
    rawFilePlan: includeRaw ? buildRawFilePlan(partPlan, file.name, inputFormat) : []
  });
}

function buildJsonlPayload(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return "";
  }

  if (records.length <= 30000) {
    return asJsonl(records);
  }

  const blobParts = [];
  let buffer = "";
  const flushThreshold = 1_500_000;

  for (let i = 0; i < records.length; i += 1) {
    buffer += JSON.stringify(records[i]);
    buffer += "\n";

    if (buffer.length >= flushThreshold) {
      blobParts.push(buffer);
      buffer = "";
    }
  }

  if (buffer.length > 0) {
    blobParts.push(buffer);
  }

  return new Blob(blobParts, { type: "application/x-ndjson" });
}

function emitProgress(stage, stageProgress, status) {
  self.postMessage({
    type: "progress",
    stage,
    stageProgress,
    status
  });
}

function normalizeFileEntry(entry) {
  if (!entry || typeof entry.path !== "string") {
    throw new Error("Worker attempted to emit an invalid file entry.");
  }

  if (typeof entry.content === "string" && entry.content.length >= LARGE_STRING_BLOB_THRESHOLD) {
    return {
      ...entry,
      content: new Blob([entry.content], { type: inferMimeType(entry.path) })
    };
  }

  return entry;
}

function estimateContentSize(content) {
  if (typeof content === "string") {
    return content.length;
  }

  if (content && typeof content.size === "number") {
    return content.size;
  }

  if (content && typeof content.byteLength === "number") {
    return content.byteLength;
  }

  return 0;
}

function inferMimeType(path) {
  const lower = (path || "").toLowerCase();

  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
    return "application/json";
  }

  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) {
    return "text/plain;charset=utf-8";
  }

  return "application/octet-stream";
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
  const chunks = payload.chunks.map((chunk) => ({ ...chunk, source_block_types: [...(chunk.source_block_types || [])] }));
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

function summarizeTextpackValidation(summaries) {
  const entries = Array.isArray(summaries) ? summaries.filter(Boolean) : [];
  const failures = [];
  let totalRecords = 0;
  let validatedRecords = 0;

  for (const summary of entries) {
    totalRecords += Number(summary.total_records) || 0;
    validatedRecords += Number(summary.validated_records) || 0;
    if (Array.isArray(summary.failures) && summary.failures.length) {
      failures.push(...summary.failures);
    }
  }

  return {
    total_records: totalRecords,
    validated_records: validatedRecords,
    failures
  };
}

function summarizeTextpackStats(summaries) {
  const entries = Array.isArray(summaries) ? summaries.filter(Boolean) : [];
  const totals = {
    raw_text_bytes: 0,
    textpack_literal_bytes: 0,
    lexicon_entries: 0,
    template_entries: 0,
    artifact_versions: 0
  };

  for (const summary of entries) {
    totals.raw_text_bytes += Number(summary.raw_text_bytes) || 0;
    totals.textpack_literal_bytes += Number(summary.textpack_literal_bytes) || 0;
    totals.lexicon_entries += Number(summary.lexicon_entries) || 0;
    totals.template_entries += Number(summary.template_entries) || 0;
    totals.artifact_versions += Number(summary.artifact_versions) || 0;
  }

  return totals;
}

function roundMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function makePreview(text) {
  if (typeof text !== "string" || !text.length) {
    return "";
  }

  if (text.length <= CHUNK_PREVIEW_MAX) {
    return text;
  }

  return `${text.slice(0, CHUNK_PREVIEW_MAX - 3)}...`;
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
