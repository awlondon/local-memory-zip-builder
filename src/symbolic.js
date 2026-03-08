import { asJsonl, clamp } from "./utils.js";

const GLYPHS = {
  architecture: "\u27C1",
  change: "\u2206",
  recurrence: "\u27F2",
  summary: "\u2211",
  procedure: "\u03BB",
  conflict: "\u2297",
  merge: "\u2295",
  decision: "\u03A9",
  artifact: "\u29C9",
  abstract: "\u221E\u0307"
};

const GLYPH_FAMILIES = [
  { glyph: GLYPHS.artifact, keywords: ["code", "table", "json", "artifact", "document section", "schema"] },
  { glyph: GLYPHS.architecture, keywords: ["architecture", "project", "design", "system", "module", "component"] },
  { glyph: GLYPHS.change, keywords: ["change", "edit", "update", "modify", "patch", "refactor"] },
  { glyph: GLYPHS.recurrence, keywords: ["again", "repeat", "loop", "recurring", "iteration", "revisit"] },
  { glyph: GLYPHS.summary, keywords: ["summary", "dataset", "aggregate", "overview", "index", "manifest"] },
  { glyph: GLYPHS.procedure, keywords: ["procedure", "function", "transform", "step", "script", "process"] },
  { glyph: GLYPHS.conflict, keywords: ["error", "failure", "conflict", "bug", "exception", "issue"] },
  { glyph: GLYPHS.merge, keywords: ["merge", "support", "dependency", "integrate", "compatible"] },
  { glyph: GLYPHS.decision, keywords: ["decision", "final", "done", "terminal", "ship", "resolved"] },
  { glyph: GLYPHS.abstract, keywords: ["theory", "abstract", "framework", "model", "principle", "semantic"] }
];

const GLYPH_ORDER = GLYPH_FAMILIES.map((family) => family.glyph);

export function buildSymbolicStreams(sessions, chunks, options = {}, onProgress = () => {}) {
  const chunksBySession = new Map();
  const chunkConcepts = options.chunkConcepts || Object.create(null);
  const chunkPhraseMap = options.chunkPhraseMap || Object.create(null);
  const chunkTextRefs = options.chunkTextRefs || Object.create(null);
  const artifactVersionByChunkId = new Map((options.artifacts || []).map((artifact) => [artifact.chunk_id, artifact]));

  for (const session of sessions) {
    chunksBySession.set(session.session_id, []);
  }
  for (const chunk of chunks) {
    chunksBySession.get(chunk.session_id)?.push(chunk);
  }

  const files = [];
  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i];
    const sessionChunks = chunksBySession.get(session.session_id) || [];
    sessionChunks.sort((a, b) => a.seq_in_session - b.seq_in_session);

    const streamRecords = sessionChunks.map((chunk, index) => {
      const glyphProfile = chooseGlyphProfile(chunk);
      const linkedArtifact = artifactVersionByChunkId.get(chunk.chunk_id) || null;
      return {
        seq: index + 1,
        chunk_id: chunk.chunk_id,
        kind: chunk.kind,
        speaker_role: chunk.speaker_role || "unknown",
        speaker_label: chunk.speaker_label || null,
        speaker_inference_source: chunk.speaker_inference_source || "unknown",
        speaker_confidence: chunk.speaker_confidence || 0,
        turn_index: Number.isFinite(chunk.turn_index) ? chunk.turn_index : null,
        turn_role: chunk.turn_role || null,
        summary_glyph: glyphProfile.glyph,
        glyph_probability: glyphProfile.probability,
        concept_ids: (chunkConcepts[chunk.chunk_id] || []).slice(0, 8).map((entry) => entry.concept_id),
        phrase_ids: (chunkPhraseMap[chunk.chunk_id] || []).slice(0, 12),
        textpack_ref: chunkTextRefs[chunk.chunk_id] || null,
        artifact_id: linkedArtifact?.artifact_id || null,
        artifact_version_id: linkedArtifact?.artifact_version_id || null,
        artifact_type: linkedArtifact?.artifact_type || chunk.artifact_type || null
      };
    });

    files.push({
      path: `local_memory/symbolic/${session.session_id}.stream.jsonl`,
      content: asJsonl(streamRecords)
    });

    onProgress(clamp((i + 1) / Math.max(1, sessions.length), 0, 1));
  }

  return files;
}

function chooseGlyphProfile(chunk) {
  const text = chunk.text.toLowerCase();
  const scores = new Map(GLYPH_ORDER.map((glyph) => [glyph, 0]));

  for (const family of GLYPH_FAMILIES) {
    for (const keyword of family.keywords) {
      if (text.includes(keyword)) {
        scores.set(family.glyph, scores.get(family.glyph) + 1);
      }
    }
  }

  if (chunk.artifact_type) {
    scores.set(GLYPHS.artifact, scores.get(GLYPHS.artifact) + 3.2);
  }
  if (chunk.kind === "decision") {
    scores.set(GLYPHS.decision, scores.get(GLYPHS.decision) + 2);
  }
  if (chunk.kind === "error") {
    scores.set(GLYPHS.conflict, scores.get(GLYPHS.conflict) + 2);
  }
  if (chunk.kind === "request" || chunk.kind === "task") {
    scores.set(GLYPHS.procedure, scores.get(GLYPHS.procedure) + 2);
  }
  if (chunk.kind === "quote") {
    scores.set(GLYPHS.summary, scores.get(GLYPHS.summary) + 1);
  }

  let bestGlyph = GLYPHS.summary;
  let bestScore = -1;
  let totalScore = 0;

  for (const glyph of GLYPH_ORDER) {
    const score = scores.get(glyph);
    totalScore += score;
    if (score > bestScore) {
      bestGlyph = glyph;
      bestScore = score;
    }
  }

  const probability = totalScore > 0 ? clamp(bestScore / totalScore, 0.08, 0.99) : 0.1;
  return {
    glyph: bestGlyph,
    probability: Number(probability.toFixed(2))
  };
}
