/**
 * Semantic memory query utility for agentic systems.
 *
 * Instead of retrieving large raw documents, an agent queries the concept graph.
 * The system returns relevant concept tokens, adjacent relationships,
 * and associated symbol streams. Only the relevant shards are reconstructed.
 *
 * This module is included in the archive as a standalone retrieval helper
 * that agents can load to traverse the memory substrate without processing
 * entire transcripts.
 */

/**
 * Produces a self-contained query protocol description and lookup tables
 * that an agent can use to navigate the archive efficiently.
 *
 * @param {Object} payload
 * @param {Array} payload.concepts - Full concept list
 * @param {Array} payload.edges - Graph edges
 * @param {Array} payload.symbols - Symbol library entries
 * @param {Object} payload.conceptToSymbol - concept_id → symbol_id map
 * @param {Array} payload.sessions - Session metadata
 * @param {number} payload.totalChunks - Total chunk count
 * @param {number} payload.rawTextBytes - Original text byte count
 * @param {number} payload.archiveBytes - Compressed archive byte estimate
 * @returns {Object} Query protocol object for serialization
 */
export function buildQueryProtocol(payload) {
  const {
    concepts = [],
    edges = [],
    symbols = [],
    conceptToSymbol = {},
    sessions = [],
    totalChunks = 0,
    rawTextBytes = 0,
    archiveBytes = 0
  } = payload;

  const conceptAdjacency = buildConceptAdjacency(concepts, edges);
  const conceptToChunks = buildConceptToChunks(concepts);
  const conceptToSessions = buildConceptToSessions(concepts, sessions);

  return {
    version: 1,
    protocol: "semantic-memory-query-v1",
    description: "Query the concept graph to retrieve relevant tokens, adjacent relationships, and associated symbol streams. Reconstruct only the relevant shards rather than processing entire transcripts.",
    retrieval_steps: [
      "1. Identify target concepts via index/concept_index.json or index/keyword_index.json",
      "2. Look up concept adjacency in this file to find related concepts",
      "3. Resolve concept_ids to symbol_ids via the concept_to_symbol map",
      "4. Use symbol_ids to filter symbolic/*.stream.jsonl for relevant chunks",
      "5. Reconstruct only the matched chunks via textpack/ using textpack_ref",
      "6. For broader context, traverse adjacent_to and follows_from edges in graph/"
    ],
    stats: {
      total_concepts: concepts.length,
      total_symbols: symbols.length,
      total_sessions: sessions.length,
      total_chunks: totalChunks,
      raw_text_bytes: rawTextBytes,
      archive_bytes: archiveBytes,
      compression_ratio: rawTextBytes > 0 && archiveBytes > 0
        ? Number((rawTextBytes / archiveBytes).toFixed(2))
        : null
    },
    concept_adjacency: conceptAdjacency,
    concept_to_chunks: conceptToChunks,
    concept_to_sessions: conceptToSessions,
    concept_to_symbol: conceptToSymbol
  };
}

function buildConceptAdjacency(concepts, edges) {
  const adjacency = Object.create(null);

  for (const concept of concepts) {
    adjacency[concept.concept_id] = [];
  }

  for (const edge of edges) {
    if (
      edge.type !== "often_cooccurs_with" &&
      edge.type !== "related_to" &&
      edge.type !== "subconcept_of"
    ) {
      continue;
    }

    if (adjacency[edge.src]) {
      adjacency[edge.src].push({
        concept_id: edge.dst,
        relation: edge.type,
        weight: edge.weight
      });
    }
  }

  return adjacency;
}

function buildConceptToChunks(concepts) {
  const map = Object.create(null);

  for (const concept of concepts) {
    map[concept.concept_id] = concept.chunk_ids || [];
  }

  return map;
}

function buildConceptToSessions(concepts, sessions) {
  const chunkToSession = new Map();
  for (const session of sessions) {
    for (const chunkId of session.chunk_ids || []) {
      chunkToSession.set(chunkId, session.session_id);
    }
  }

  const map = Object.create(null);

  for (const concept of concepts) {
    const sessionSet = new Set();
    for (const chunkId of concept.chunk_ids || []) {
      const sessionId = chunkToSession.get(chunkId);
      if (sessionId) {
        sessionSet.add(sessionId);
      }
    }
    map[concept.concept_id] = [...sessionSet].sort();
  }

  return map;
}
