import { asJsonl } from "./utils.js";

export function buildSessionManifest(sessions) {
  return asJsonl(
    sessions.map((session) => ({
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
      ai_turn_ratio: session.ai_turn_ratio || 0
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
      artifact_label: chunk.artifact_label || null,
      speaker_role: chunk.speaker_role || "unknown",
      speaker_label: chunk.speaker_label || null,
      speaker_inference_source: chunk.speaker_inference_source || "unknown",
      speaker_confidence: chunk.speaker_confidence || 0,
      turn_index: Number.isFinite(chunk.turn_index) ? chunk.turn_index : null,
      turn_role: chunk.turn_role || null,
      turn_count: chunk.turn_count || 1,
      speaker_sequence_preview: chunk.speaker_sequence_preview || ""
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
    end_offset: session.end_offset,
    turn_count: session.turn_count || 0,
    speaker_profile: session.speaker_profile || "unknown",
    has_human: (session.human_turn_count || 0) > 0,
    has_ai: (session.ai_turn_count || 0) > 0,
    human_turn_count: session.human_turn_count || 0,
    ai_turn_count: session.ai_turn_count || 0,
    system_turn_count: session.system_turn_count || 0,
    tool_turn_count: session.tool_turn_count || 0,
    unknown_turn_count: session.unknown_turn_count || 0,
    ai_turn_ratio: session.ai_turn_ratio || 0,
    dominant_human_label: session.dominant_human_label || null,
    dominant_ai_label: session.dominant_ai_label || null,
    session_speakers: session.session_speakers || [],
    speaker_sequence_preview: session.speaker_sequence_preview || ""
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
    "Local Memory Archive - Semantic Memory Substrate",
    "",
    "1) Unzip this archive locally.",
    "2) Open core-obsessions-graph.html for a browser-based overview of recurring archive themes and linked thread reconstruction.",
    "3) Keep the local_memory/ directory intact (do not rename internal folders).",
    "4) Point your local coding or LLM agent at local_memory/.",
    "5) Ask the agent to read manifest/corpus.json and index/*.json before opening large payload shards.",
    "6) Load index/query_protocol.json when you need concept adjacency, symbol mappings, or chunk lookup tables.",
    "7) Prefer speaker_role, turn_role, speaker_inference_source, and speaker_confidence before re-inferring identity from raw text.",
    "8) Use symbolic/*.stream.jsonl for fast retrieval cues and textpack/ for exact chunk reconstruction, including speaker metadata.",
    "9) Open chunks/chunk_text_part_*.jsonl only as a compatibility fallback or when speaker_role is unknown or mixed.",
    "10) Open raw session shards only for grounded span-level inspection when they are present.",
    "",
    "Notes:",
    "- This archive is retrieval-oriented metadata, not a fine-tuning dataset.",
    "- Conversation-style JSON exports are normalized into explicit transcript turns",
    "  when author role and content order can be recovered.",
    "- symbolic/symbol_library.json maps concept clusters to reusable glyph bins for compact retrieval.",
    "- Section headings are structural and should not be counted as conversational turns.",
    "- symbolic/*.stream.jsonl is a retrieval contour; reconstruction comes from textpack/.",
    "- For very large inputs, processing runs in sequential source parts;",
    "  check generation_report.json source_parts for details."
  ].join("\n");
}
