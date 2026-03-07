import { clamp, makeId, normalizeConceptKey, normalizeWhitespace, tokenizeWithoutStopWords } from "./utils.js";

const AGGRESSIVENESS_CONFIG = {
  low: {
    minChunkMentions: 3,
    minTotalMentions: 4,
    maxConceptsFactor: 0.3
  },
  medium: {
    minChunkMentions: 2,
    minTotalMentions: 3,
    maxConceptsFactor: 0.45
  },
  high: {
    minChunkMentions: 2,
    minTotalMentions: 2,
    maxConceptsFactor: 0.6
  }
};

export function extractConcepts(chunks, settings, onProgress = () => {}) {
  const config = AGGRESSIVENESS_CONFIG[settings.conceptAggressiveness] || AGGRESSIVENESS_CONFIG.medium;
  const candidateMap = new Map();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const candidates = extractCandidatesForChunk(chunk.text);

    for (const candidate of candidates) {
      const key = normalizeConceptKey(candidate.surface);
      if (!key || key.length < 3 || key.split(" ").length > 6) {
        continue;
      }

      if (!candidateMap.has(key)) {
        candidateMap.set(key, {
          key,
          surfaceCounts: new Map(),
          chunkMentions: new Map(),
          sessionIds: new Set(),
          totalMentions: 0
        });
      }

      const item = candidateMap.get(key);
      item.totalMentions += candidate.count;
      item.sessionIds.add(chunk.session_id);

      const surfaceCount = item.surfaceCounts.get(candidate.surface) || 0;
      item.surfaceCounts.set(candidate.surface, surfaceCount + candidate.count);

      const chunkCount = item.chunkMentions.get(chunk.chunk_id) || 0;
      item.chunkMentions.set(chunk.chunk_id, chunkCount + candidate.count);
    }

    if ((index + 1) % 20 === 0 || index === chunks.length - 1) {
      onProgress(clamp((index + 1) / Math.max(1, chunks.length), 0, 1));
    }
  }

  const filtered = [];
  const chunkCountMax = Math.max(1, chunks.length);

  for (const candidate of candidateMap.values()) {
    const chunkMentions = candidate.chunkMentions.size;
    if (chunkMentions < config.minChunkMentions || candidate.totalMentions < config.minTotalMentions) {
      continue;
    }

    const label = bestSurface(candidate.surfaceCounts, candidate.key);
    const occurrenceRatio = chunkMentions / chunkCountMax;
    const sessionSpread = candidate.sessionIds.size;
    const mentionStrength = Math.log2(candidate.totalMentions + 1);

    filtered.push({
      key: candidate.key,
      label,
      chunkMentions,
      totalMentions: candidate.totalMentions,
      occurrenceRatio,
      sessionSpread,
      mentionStrength,
      chunkMentionMap: candidate.chunkMentions,
      surfaces: candidate.surfaceCounts
    });
  }

  let maxMentions = 1;
  let maxSpread = 1;
  for (const item of filtered) {
    if (item.totalMentions > maxMentions) {
      maxMentions = item.totalMentions;
    }
    if (item.sessionSpread > maxSpread) {
      maxSpread = item.sessionSpread;
    }
  }

  for (const item of filtered) {
    const mentionScore = item.totalMentions / maxMentions;
    const spreadScore = item.sessionSpread / maxSpread;
    const chunkScore = item.occurrenceRatio;
    item.importance = clamp(0.46 * mentionScore + 0.32 * spreadScore + 0.22 * chunkScore, 0, 1);
  }

  filtered.sort((a, b) => {
    if (b.importance !== a.importance) {
      return b.importance - a.importance;
    }
    if (b.totalMentions !== a.totalMentions) {
      return b.totalMentions - a.totalMentions;
    }
    return a.label.localeCompare(b.label);
  });

  const maxConcepts = Math.max(10, Math.min(800, Math.round(chunks.length * config.maxConceptsFactor)));
  const selected = filtered.slice(0, maxConcepts);

  const concepts = [];
  const chunkConcepts = Object.create(null);

  for (let i = 0; i < selected.length; i += 1) {
    const source = selected[i];
    const conceptId = makeId("concept", i + 1);
    const aliasCandidates = [...source.surfaces.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map((entry) => entry[0])
      .filter((surface) => normalizeConceptKey(surface) !== normalizeConceptKey(source.label))
      .slice(0, 2);

    const chunkIds = [...source.chunkMentionMap.keys()].sort((a, b) => a.localeCompare(b));

    concepts.push({
      concept_id: conceptId,
      label: source.label,
      aliases: aliasCandidates,
      importance: Number(source.importance.toFixed(4)),
      recurrence_count: source.chunkMentions,
      chunk_ids: chunkIds
    });

    for (const [chunkId, mentionCount] of source.chunkMentionMap.entries()) {
      if (!chunkConcepts[chunkId]) {
        chunkConcepts[chunkId] = [];
      }

      chunkConcepts[chunkId].push({
        concept_id: conceptId,
        score: mentionCount + source.importance
      });
    }
  }

  for (const links of Object.values(chunkConcepts)) {
    links.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.concept_id.localeCompare(b.concept_id);
    });
  }

  return { concepts, chunkConcepts };
}

function extractCandidatesForChunk(text) {
  const candidateCounts = new Map();
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const quotedRegex = /"([^"\n]{3,80})"|'([^'\n]{3,80})'/g;
  let match;
  while ((match = quotedRegex.exec(text)) !== null) {
    const phrase = normalizeWhitespace(match[1] || match[2] || "");
    if (phrase.length >= 3) {
      incrementCandidate(candidateCounts, phrase, 2);
    }
  }

  const titleRegex = /\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,4})\b/g;
  while ((match = titleRegex.exec(text)) !== null) {
    const phrase = normalizeWhitespace(match[1]);
    if (phrase.length >= 3) {
      incrementCandidate(candidateCounts, phrase, 1.5);
    }
  }

  const tokens = tokenizeWithoutStopWords(normalized);
  addNgrams(candidateCounts, tokens, 2, 1.2);
  addNgrams(candidateCounts, tokens, 3, 1.0);
  addNgrams(candidateCounts, tokens, 4, 0.85);

  return [...candidateCounts.entries()]
    .map(([surface, count]) => ({ surface, count }))
    .filter((item) => item.count >= 1);
}

function addNgrams(map, tokens, n, weight) {
  if (tokens.length < n) {
    return;
  }

  for (let i = 0; i <= tokens.length - n; i += 1) {
    const gram = tokens.slice(i, i + n);
    if (gram.some((token) => token.length < 3)) {
      continue;
    }

    const phrase = gram.join(" ");
    incrementCandidate(map, phrase, weight);
  }
}

function incrementCandidate(map, phrase, value) {
  const current = map.get(phrase) || 0;
  map.set(phrase, current + value);
}

function bestSurface(surfaceCounts, fallback) {
  if (!surfaceCounts.size) {
    return fallback;
  }

  const sorted = [...surfaceCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });

  return sorted[0][0];
}

