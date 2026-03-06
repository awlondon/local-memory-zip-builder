import { clamp, jaccardFromSets, tokenizeForSimilarity } from "./utils.js";

export function buildGraphArtifacts(payload, onProgress = () => {}) {
  const { sessions, chunks, concepts, chunkConcepts } = payload;

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const conceptById = new Map(concepts.map((concept) => [concept.concept_id, concept]));

  const edges = [];
  const seen = new Set();

  function addEdge(src, dst, type, weight) {
    const key = `${src}|${dst}|${type}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    edges.push({
      src,
      dst,
      type,
      weight: Number(clamp(weight, 0, 1).toFixed(4))
    });
  }

  for (const chunk of chunks) {
    const links = chunkConcepts[chunk.chunk_id] || [];
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      const relationType = i === 0 ? "primary_topic_of" : "mentioned_in";
      const relationWeight = i === 0 ? 0.65 + link.score * 0.05 : 0.4 + link.score * 0.04;
      addEdge(link.concept_id, chunk.chunk_id, relationType, relationWeight);
    }
  }
  onProgress(0.25);

  for (const session of sessions) {
    for (let i = 1; i < session.chunk_ids.length; i += 1) {
      const previousId = session.chunk_ids[i - 1];
      const currentId = session.chunk_ids[i];
      addEdge(previousId, currentId, "adjacent_to", 1);

      const previousChunk = chunkById.get(previousId);
      const currentChunk = chunkById.get(currentId);
      const similarity = jaccardFromSets(
        tokenizeForSimilarity(previousChunk.text),
        tokenizeForSimilarity(currentChunk.text)
      );
      if (similarity >= 0.14) {
        addEdge(previousId, currentId, "follows_from", 0.35 + similarity);
      }

      if (/\b(above|earlier|previous|reference|as discussed)\b/i.test(currentChunk.text)) {
        addEdge(currentId, previousId, "references", 0.62);
      }
    }
  }
  onProgress(0.45);

  const sessionConceptSets = new Map();
  for (const session of sessions) {
    sessionConceptSets.set(session.session_id, new Set(session.concept_ids));
  }

  for (let i = 1; i < sessions.length; i += 1) {
    const previous = sessions[i - 1];
    const current = sessions[i];
    const overlap = setOverlapRatio(
      sessionConceptSets.get(previous.session_id),
      sessionConceptSets.get(current.session_id)
    );

    if (overlap > 0) {
      addEdge(previous.session_id, current.session_id, "continues", 0.36 + overlap);
    }

    if (overlap >= 0.2) {
      addEdge(previous.session_id, current.session_id, "same_theme_as", 0.42 + overlap);
    }

    if (i > 1) {
      let bestMatch = null;
      let bestOverlap = 0;
      for (let j = i - 2; j >= 0; j -= 1) {
        const candidate = sessions[j];
        const candidateOverlap = setOverlapRatio(
          sessionConceptSets.get(candidate.session_id),
          sessionConceptSets.get(current.session_id)
        );

        if (candidateOverlap > bestOverlap) {
          bestOverlap = candidateOverlap;
          bestMatch = candidate;
        }
      }

      if (bestMatch && bestOverlap >= 0.28) {
        addEdge(current.session_id, bestMatch.session_id, "revisits", 0.4 + bestOverlap);
      }
    }
  }
  onProgress(0.65);

  const conceptPairs = [];
  for (let i = 0; i < concepts.length; i += 1) {
    for (let j = i + 1; j < concepts.length; j += 1) {
      conceptPairs.push([concepts[i], concepts[j]]);
    }
  }

  for (let i = 0; i < conceptPairs.length; i += 1) {
    const [conceptA, conceptB] = conceptPairs[i];
    const overlapCount = countOverlap(conceptA.chunk_ids, conceptB.chunk_ids);

    if (overlapCount >= 2) {
      addEdge(conceptA.concept_id, conceptB.concept_id, "often_cooccurs_with", 0.35 + overlapCount * 0.08);
    }

    const labelSetA = tokenizeForSimilarity(conceptA.label);
    const labelSetB = tokenizeForSimilarity(conceptB.label);
    const labelSimilarity = jaccardFromSets(labelSetA, labelSetB);

    if (labelSimilarity >= 0.45) {
      addEdge(conceptA.concept_id, conceptB.concept_id, "related_to", 0.3 + labelSimilarity);
    }

    if (conceptA.label.length > conceptB.label.length && conceptA.label.toLowerCase().includes(conceptB.label.toLowerCase())) {
      addEdge(conceptA.concept_id, conceptB.concept_id, "subconcept_of", 0.65);
    } else if (conceptB.label.length > conceptA.label.length && conceptB.label.toLowerCase().includes(conceptA.label.toLowerCase())) {
      addEdge(conceptB.concept_id, conceptA.concept_id, "subconcept_of", 0.65);
    }

    if (
      /\b(vs|versus|tradeoff|not)\b/i.test(conceptA.label) &&
      /\b(vs|versus|tradeoff|not)\b/i.test(conceptB.label)
    ) {
      addEdge(conceptA.concept_id, conceptB.concept_id, "contrasts_with", 0.45);
    }

    if ((i + 1) % 400 === 0 || i === conceptPairs.length - 1) {
      onProgress(0.65 + 0.35 * ((i + 1) / Math.max(1, conceptPairs.length)));
    }
  }

  edges.sort((a, b) => {
    if (a.src !== b.src) {
      return a.src.localeCompare(b.src);
    }
    if (a.type !== b.type) {
      return a.type.localeCompare(b.type);
    }
    return a.dst.localeCompare(b.dst);
  });

  const conceptStats = concepts.map((concept) => {
    const conceptEdges = edges.filter((edge) => edge.src === concept.concept_id || edge.dst === concept.concept_id);
    const chunkEdges = conceptEdges.filter((edge) => edge.dst.startsWith("chunk_"));
    const conceptEdgesOnly = conceptEdges.filter(
      (edge) => edge.src.startsWith("concept_") && edge.dst.startsWith("concept_")
    );

    return {
      concept_id: concept.concept_id,
      label: concept.label,
      degree_total: conceptEdges.length,
      chunk_degree: chunkEdges.length,
      concept_degree: conceptEdgesOnly.length
    };
  });

  return { edges, conceptStats };
}

function countOverlap(a, b) {
  const set = new Set(a);
  let count = 0;
  for (const value of b) {
    if (set.has(value)) {
      count += 1;
    }
  }
  return count;
}

function setOverlapRatio(a, b) {
  if (!a?.size || !b?.size) {
    return 0;
  }

  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }

  const base = Math.max(a.size, b.size);
  return base === 0 ? 0 : intersection / base;
}
