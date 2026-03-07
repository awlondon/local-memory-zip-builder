import { clamp, jaccardFromSets, tokenizeForSimilarity } from "./utils.js";

export function buildGraphArtifacts(payload, onProgress = () => {}) {
  const { sessions, chunks, concepts, chunkConcepts, artifacts = [] } = payload;

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const artifactByChunkId = new Map(artifacts.map((artifact) => [artifact.chunk_id, artifact]));
  const artifactVersionsByArtifactId = new Map();
  for (const artifact of artifacts) {
    if (!artifactVersionsByArtifactId.has(artifact.artifact_id)) {
      artifactVersionsByArtifactId.set(artifact.artifact_id, []);
    }
    artifactVersionsByArtifactId.get(artifact.artifact_id).push(artifact);
  }

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

      const artifactVersion = artifactByChunkId.get(chunk.chunk_id);
      if (artifactVersion) {
        addEdge(link.concept_id, artifactVersion.artifact_version_id, "mentioned_in_artifact", 0.42 + link.score * 0.04);
      }
    }
  }
  onProgress(0.2);

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
  onProgress(0.4);

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
  }
  onProgress(0.58);

  for (const artifactVersions of artifactVersionsByArtifactId.values()) {
    artifactVersions.sort((a, b) => a.version_index - b.version_index || a.chunk_id.localeCompare(b.chunk_id));

    for (let index = 0; index < artifactVersions.length; index += 1) {
      const artifact = artifactVersions[index];
      addEdge(artifact.artifact_id, artifact.artifact_version_id, "contains", 0.97);
      addEdge(artifact.artifact_version_id, artifact.artifact_id, "revision_of", 0.94);
      addEdge(artifact.artifact_version_id, artifact.chunk_id, "materialized_as", 0.99);
      addEdge(artifact.session_id, artifact.artifact_id, "contains", 0.76);

      if (index > 0) {
        const previousVersion = artifactVersions[index - 1];
        const similarity = jaccardFromSets(
          tokenizeForSimilarity(chunkById.get(previousVersion.chunk_id)?.text || ""),
          tokenizeForSimilarity(chunkById.get(artifact.chunk_id)?.text || "")
        );
        addEdge(artifact.artifact_version_id, previousVersion.artifact_version_id, "derived_from", 0.48 + similarity * 0.45);
      }
    }
  }
  onProgress(0.72);

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

    if ((i + 1) % 400 === 0 || i === conceptPairs.length - 1) {
      onProgress(0.72 + 0.28 * ((i + 1) / Math.max(1, conceptPairs.length)));
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
    const artifactEdges = conceptEdges.filter((edge) => edge.dst.startsWith("artifact_version_"));

    return {
      concept_id: concept.concept_id,
      label: concept.label,
      degree_total: conceptEdges.length,
      chunk_degree: chunkEdges.length,
      concept_degree: conceptEdgesOnly.length,
      artifact_degree: artifactEdges.length
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
