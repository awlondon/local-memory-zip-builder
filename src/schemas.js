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
      text_preview: chunk.text_preview || ""
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
      edges: counters.edges
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
    estimated_processing_duration_ms: payload.estimatedDurationMs,
    warnings: payload.warnings,
    limits: payload.limits
  };
}

export function buildInstructionsFile() {
  return [
    "Local Memory Archive Instructions",
    "",
    "1) Unzip this archive locally.",
    "2) Keep the local_memory/ directory intact (do not rename internal folders).",
    "3) Point your local coding or LLM agent at local_memory/.",
    "4) Ask the agent to read manifest/corpus.json and index/*.json before opening large raw shards.",
    "4a) For grounded details, use chunks/chunk_text_part_*.jsonl via index/chunk_text_shards.json.",
    "5) Let the agent open raw session shards only for grounded span-level inspection.",
    "",
    "Notes:",
    "- This archive is retrieval-oriented metadata, not a fine-tuning dataset.",
    "- symbolic/*.stream.jsonl is a lightweight contour and should not be treated as complete truth.",
    "- Browser memory limits still apply for very large files.",
    "- For very large inputs, processing runs in sequential source parts; check generation_report.json source_parts for details."
  ].join("\n");
}
