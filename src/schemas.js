import { asJsonl } from "./utils.js";

export function buildSessionManifest(sessions) {
  return asJsonl(
    sessions.map((session) => ({
      session_id: session.session_id,
      title: session.title,
      start_offset: session.start_offset,
      end_offset: session.end_offset,
      chunk_ids: session.chunk_ids,
      concept_ids: session.concept_ids
    }))
  );
}

export function buildChunkManifest(chunks) {
  return asJsonl(
    chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      session_id: chunk.session_id,
      seq_in_session: chunk.seq_in_session,
      kind: chunk.kind,
      start_offset: chunk.start_offset,
      end_offset: chunk.end_offset,
      text_preview: chunk.text_preview || "",
      text_ref: chunk.text_ref || null,
      artifact_type: chunk.artifact_type || null,
      artifact_label: chunk.artifact_label || null
    }))
  );
}

export function buildConceptIndex(concepts) {
  const entries = {};

  for (const concept of concepts) {
    entries[concept.label] = {
      concept_id: concept.concept_id,
      importance: concept.importance,
      recurrence_count: concept.recurrence_count,
      chunk_ids: concept.chunk_ids
    };
  }

  return entries;
}

export function buildSessionIndex(sessions) {
  return sessions.map((session) => ({
    session_id: session.session_id,
    title: session.title,
    chunk_count: session.chunk_ids.length,
    concept_count: session.concept_ids.length,
    start_offset: session.start_offset,
    end_offset: session.end_offset
  }));
}

export function buildCorpusManifest(inputFileName, byteLength, settings, counters) {
  return {
    corpus_name: `${inputFileName}-local-memory`,
    input_filename: inputFileName,
    bytes_processed: byteLength,
    deterministic: true,
    settings,
    totals: {
      sessions: counters.sessions,
      chunks: counters.chunks,
      concepts: counters.concepts,
      edges: counters.edges,
      artifact_versions: counters.artifact_versions || 0
    }
  };
}

export function buildGenerationReport(payload) {
  return {
    input_filename: payload.inputFilename,
    bytes_processed: payload.bytesProcessed,
    generation_timestamp_utc: payload.generationTimestamp,
    total_sessions: payload.totalSessions,
    total_chunks: payload.totalChunks,
    total_concepts: payload.totalConcepts,
    total_edges: payload.totalEdges,
    total_artifact_versions: payload.totalArtifactVersions || 0,
    estimated_processing_duration_ms: payload.estimatedDurationMs,
    warnings: payload.warnings,
    limits: payload.limits,
    textpack: payload.textpack || null
  };
}

export function buildTextpackManifest(payload) {
  return {
    version: payload.version,
    encoding: payload.encoding,
    shards: payload.shards,
    dictionary: payload.dictionary,
    delta: payload.delta,
    stats: payload.stats
  };
}

export function buildInstructionsFile() {
  return [
    "Local Memory Archive Instructions",
    "",
    "1) Unzip this archive locally.",
    "2) Keep the local_memory/ directory intact (do not rename internal folders).",
    "3) Point your local coding or LLM agent at local_memory/.",
    "4) Ask the agent to read manifest/corpus.json and index/*.json before opening large payload shards.",
    "5) Prefer symbolic/*.stream.jsonl for fast retrieval cues and textpack/ for exact chunk reconstruction.",
    "6) Use chunks/chunk_text_part_*.jsonl only as a compatibility fallback during the rollout window.",
    "7) Let the agent open raw session shards only for grounded span-level inspection when they are present.",
    "",
    "Notes:",
    "- This archive is retrieval-oriented metadata, not a fine-tuning dataset.",
    "- symbolic/*.stream.jsonl is a retrieval contour with textpack references; reconstruction should come from textpack/.",
    "- Browser memory limits still apply for very large files.",
    "- For very large inputs, processing runs in sequential source parts; check generation_report.json source_parts for details."
  ].join("\n");
}
