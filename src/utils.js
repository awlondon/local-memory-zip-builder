export const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "here", "him",
  "his", "i", "if", "in", "into", "is", "it", "its", "just", "me", "more", "most", "my",
  "not", "of", "on", "or", "our", "out", "she", "so", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "too", "up", "us", "was", "we", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your"
]);

export function padNumber(number, width = 6) {
  return String(number).padStart(width, "0");
}

export function makeId(prefix, number, width = 6) {
  return `${prefix}_${padNumber(number, width)}`;
}

export function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

export function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function normalizeConceptKey(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

export function normalizeArtifactKey(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s:_\-]/g, "")
    .trim();
}

export function tokenize(text) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9_\-']*/g);
  return matches ? matches.filter((token) => token.length > 1) : [];
}

export function tokenizeWithoutStopWords(text) {
  return tokenize(text).filter((token) => !STOP_WORDS.has(token));
}

export function tokenizeForSimilarity(text) {
  return new Set(tokenizeWithoutStopWords(text));
}

export function jaccardFromSets(setA, setB) {
  if (!setA.size && !setB.size) {
    return 1;
  }
  if (!setA.size || !setB.size) {
    return 0;
  }

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function splitSentencesWithOffsets(text, baseOffset) {
  const units = [];
  const pattern = /[^.!?\n]+(?:[.!?]+|$)/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const rawSegment = match[0];
    const sentence = normalizeWhitespace(rawSegment);
    if (!sentence) {
      continue;
    }

    const trimmedLeading = rawSegment.match(/^\s*/)?.[0].length || 0;
    const localStart = match.index + trimmedLeading;
    const localEnd = localStart + sentence.length;

    units.push({
      text: sentence,
      start_offset: baseOffset + localStart,
      end_offset: baseOffset + localEnd
    });
  }

  if (!units.length) {
    const fallback = normalizeWhitespace(text);
    if (fallback) {
      units.push({
        text: fallback,
        start_offset: baseOffset,
        end_offset: baseOffset + fallback.length
      });
    }
  }

  return units;
}

export function asJsonl(records) {
  if (!records.length) {
    return "";
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function safeTitle(text, fallback) {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find((line) => line.length > 0);

  if (!firstLine) {
    return fallback;
  }

  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
}

export function deterministicTimestampFromFile(file) {
  if (file && Number.isFinite(file.lastModified) && file.lastModified > 0) {
    return new Date(file.lastModified).toISOString();
  }
  return new Date(0).toISOString();
}

export function estimateDeterministicDurationMs(byteLength, sessionCount, chunkCount) {
  const base = 350;
  const byteComponent = byteLength / 17000;
  const sessionComponent = sessionCount * 90;
  const chunkComponent = chunkCount * 24;
  return Math.round(base + byteComponent + sessionComponent + chunkComponent);
}

export function createShards(records, prefix, folder, shardSize) {
  const files = [];

  if (!records.length) {
    files.push({
      path: `${folder}/${prefix}_${padNumber(1)}.jsonl`,
      content: ""
    });
    return files;
  }

  let cursor = 0;
  let shardIndex = 1;
  while (cursor < records.length) {
    const shardRecords = records.slice(cursor, cursor + shardSize);
    const fileName = `${folder}/${prefix}_${padNumber(shardIndex)}.jsonl`;
    files.push({ path: fileName, content: asJsonl(shardRecords) });
    cursor += shardSize;
    shardIndex += 1;
  }

  return files;
}

export function toKeywordMap(concepts) {
  const keywordMap = new Map();

  for (const concept of concepts) {
    const labelTokens = tokenizeWithoutStopWords(concept.label);
    for (const token of labelTokens) {
      if (!keywordMap.has(token)) {
        keywordMap.set(token, []);
      }
      keywordMap.get(token).push(concept.concept_id);
    }
  }

  const object = {};
  const sortedKeys = [...keywordMap.keys()].sort((a, b) => a.localeCompare(b));

  for (const key of sortedKeys) {
    object[key] = [...new Set(keywordMap.get(key))].sort((a, b) => a.localeCompare(b));
  }

  return object;
}

export function stableHash(text) {
  const source = String(text || "");
  let h1 = 0xdeadbeef ^ source.length;
  let h2 = 0x41c6ce57 ^ source.length;

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

export function longestCommonPrefix(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

export function longestCommonSuffix(a, b, prefixFloor = 0) {
  const left = String(a || "");
  const right = String(b || "");
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < max - prefixFloor &&
    left.charCodeAt(left.length - 1 - index) === right.charCodeAt(right.length - 1 - index)
  ) {
    index += 1;
  }
  return index;
}

export function takeLeadingWords(text, count = 12) {
  return tokenizeWithoutStopWords(text).slice(0, count).join(" ");
}

export function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}
