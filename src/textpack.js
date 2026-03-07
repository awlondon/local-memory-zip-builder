import { validateTextpackBundle } from "./reconstruct.js";
import {
  clamp,
  longestCommonPrefix,
  longestCommonSuffix,
  normalizeArtifactKey,
  normalizeWhitespace,
  padNumber,
  stableHash,
  takeLeadingWords,
  tokenize,
  uniqueStrings
} from "./utils.js";

const MAX_LEXICON_ENTRIES = 256;
const MAX_TEMPLATE_ENTRIES = 64;
const RECENT_RECORD_WINDOW = 32;

export function buildTextpackBundle(chunks, chunkConcepts, options = {}) {
  const onArtifactProgress = options.onArtifactProgress || (() => {});
  const onEncodingProgress = options.onEncodingProgress || (() => {});

  const lexicon = buildLexicon(chunks);
  const templates = buildTemplates(chunks);
  const artifacts = promoteArtifacts(chunks, chunkConcepts, onArtifactProgress);
  const artifactVersionByChunkId = new Map(artifacts.map((artifact) => [artifact.chunk_id, artifact]));
  const lexiconFirstCharMap = buildLexiconFirstCharMap(lexicon);

  const literalParts = [];
  let literalLength = 0;
  const literalCache = new Map();

  function storeLiteral(text) {
    const value = String(text || "");
    if (!value.length) {
      return { offset: literalLength, length: 0 };
    }

    if (literalCache.has(value)) {
      return literalCache.get(value);
    }

    const reference = { offset: literalLength, length: value.length };
    literalParts.push(value);
    literalLength += value.length;
    literalCache.set(value, reference);
    return reference;
  }

  const records = [];
  const recordByTextHash = new Map();
  const recentRecords = [];
  const chunkTextRefs = Object.create(null);
  const chunkPhraseMap = Object.create(null);
  const expectedByRecord = new Map();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const textHash = stableHash(chunk.text);

    if (recordByTextHash.has(textHash) && recordByTextHash.get(textHash).text === chunk.text) {
      const existing = recordByTextHash.get(textHash);
      chunkTextRefs[chunk.chunk_id] = makeTextRef(existing.record);
      chunkPhraseMap[chunk.chunk_id] = existing.recordData.phrase_ids || [];
      continue;
    }

    const template = chooseTemplate(chunk.text, templates);
    const directRecord = buildDirectRecord(chunk.text, template, lexiconFirstCharMap, storeLiteral);
    const directCost = estimateDirectCost(directRecord);
    const deltaRecord = options.enableDeltaEncoding === false ? null : chooseDeltaRecord(chunk.text, recentRecords, directCost, storeLiteral);
    const recordData = deltaRecord && deltaRecord.cost < directCost ? deltaRecord.record : directRecord;

    const recordNumber = records.length + 1;
    const finalRecord = {
      record: recordNumber,
      chunk_ids: [chunk.chunk_id],
      template_id: recordData.template_id,
      phrase_ids: uniqueStrings(recordData.phrase_ids || []),
      literal_spans: recordData.literal_spans || [],
      segments: recordData.segments || [],
      base_record: Number.isFinite(recordData.base_record) ? recordData.base_record : null,
      patch_ops: recordData.patch_ops || [],
      text_hash: textHash,
      artifact_version_id: artifactVersionByChunkId.get(chunk.chunk_id)?.artifact_version_id || null
    };

    records.push(finalRecord);
    expectedByRecord.set(recordNumber, chunk.text);
    recordByTextHash.set(textHash, { record: recordNumber, text: chunk.text, recordData: finalRecord });
    recentRecords.push({ record: recordNumber, text: chunk.text });
    if (recentRecords.length > RECENT_RECORD_WINDOW) {
      recentRecords.shift();
    }

    chunkTextRefs[chunk.chunk_id] = makeTextRef(recordNumber);
    chunkPhraseMap[chunk.chunk_id] = finalRecord.phrase_ids;
    onEncodingProgress(clamp((index + 1) / Math.max(1, chunks.length), 0, 1));
  }

  for (const artifact of artifacts) {
    artifact.text_ref = chunkTextRefs[artifact.chunk_id] || null;
  }

  const literalStore = literalParts.join("");
  const literalBlob = new Blob([new TextEncoder().encode(literalStore)], { type: "application/octet-stream" });
  const recordPath = "local_memory/textpack/textpack_000001.index.jsonl";
  const shardPath = "local_memory/textpack/textpack_000001.bin";
  const files = [
    {
      path: "local_memory/textpack/lexicon_global.json",
      content: JSON.stringify({ entries: lexicon }, null, 2)
    },
    {
      path: "local_memory/textpack/templates.json",
      content: JSON.stringify({ entries: templates }, null, 2)
    },
    {
      path: recordPath,
      content: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    },
    {
      path: shardPath,
      content: literalBlob,
      options: { compression: literalBlob.size > 24 * 1024 * 1024 ? "STORE" : "DEFLATE" }
    }
  ];

  const manifest = {
    version: 1,
    encoding: "phrase-template-literal-v1",
    shards: [
      {
        path: shardPath,
        index_path: recordPath,
        record_count: records.length
      }
    ],
    dictionary: {
      lexicon_path: "local_memory/textpack/lexicon_global.json",
      templates_path: "local_memory/textpack/templates.json"
    },
    delta: {
      enabled: options.enableDeltaEncoding !== false,
      max_depth: 1
    },
    stats: {
      raw_text_bytes: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      textpack_literal_bytes: literalBlob.size,
      lexicon_entries: lexicon.length,
      template_entries: templates.length,
      artifact_versions: artifacts.length
    }
  };

  files.push({
    path: "local_memory/textpack/textpack_manifest.json",
    content: JSON.stringify(manifest, null, 2)
  });

  const validation = validateTextpackBundle(
    {
      records,
      lexicon,
      templates,
      literalStore,
      hashText: stableHash
    },
    expectedByRecord
  );

  return {
    files,
    manifest,
    chunkTextRefs,
    chunkPhraseMap,
    artifacts,
    validation,
    shardPaths: [shardPath, recordPath],
    stats: manifest.stats
  };
}

function promoteArtifacts(chunks, chunkConcepts, onProgress) {
  const grouped = new Map();
  const artifactVersions = [];
  let artifactCounter = 1;
  let versionCounter = 1;

  const promotedChunks = chunks.filter((chunk) => Boolean(chunk.artifact_type));

  for (let index = 0; index < promotedChunks.length; index += 1) {
    const chunk = promotedChunks[index];
    const label = chunk.artifact_label || takeLeadingWords(chunk.text, 10) || chunk.kind;
    const groupKey = `${chunk.artifact_type}:${normalizeArtifactKey(label) || stableHash(label)}`;

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        artifact_id: `artifact_${padNumber(artifactCounter++)}`,
        artifact_type: chunk.artifact_type,
        label,
        versions: []
      });
    }

    grouped.get(groupKey).versions.push(chunk);
    onProgress(clamp((index + 1) / Math.max(1, promotedChunks.length), 0, 1));
  }

  for (const group of grouped.values()) {
    group.versions.sort((a, b) => a.start_offset - b.start_offset || a.chunk_id.localeCompare(b.chunk_id));
    for (let index = 0; index < group.versions.length; index += 1) {
      const chunk = group.versions[index];
      const linkedConceptIds = (chunkConcepts[chunk.chunk_id] || []).map((entry) => entry.concept_id);
      artifactVersions.push({
        artifact_id: group.artifact_id,
        artifact_version_id: `artifact_version_${padNumber(versionCounter++)}`,
        artifact_type: group.artifact_type,
        label: group.label,
        version_index: index + 1,
        chunk_id: chunk.chunk_id,
        session_id: chunk.session_id,
        start_offset: chunk.start_offset,
        end_offset: chunk.end_offset,
        text_hash: stableHash(chunk.text),
        concept_ids: linkedConceptIds
      });
    }
  }

  return artifactVersions;
}

function buildLexicon(chunks) {
  const counts = new Map();

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    const seen = new Set();
    for (let size = 3; size <= 6; size += 1) {
      for (let index = 0; index <= tokens.length - size; index += 1) {
        const phrase = tokens.slice(index, index + size).join(" ");
        if (phrase.length < 12) {
          continue;
        }
        if (seen.has(phrase)) {
          continue;
        }
        seen.add(phrase);
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_LEXICON_ENTRIES)
    .map(([text, count], index) => ({
      phrase_id: `phrase_${padNumber(index + 1)}`,
      text,
      recurrence_count: count
    }));
}

function buildTemplates(chunks) {
  const pairs = new Map();

  for (const chunk of chunks) {
    if (chunk.text.length < 72) {
      continue;
    }

    const prefix = chunk.text.slice(0, 24);
    const suffix = chunk.text.slice(-24);
    const key = `${prefix}\u241f${suffix}`;
    if (!pairs.has(key)) {
      pairs.set(key, { prefix, suffix, count: 0, artifact_type: chunk.artifact_type || null });
    }
    pairs.get(key).count += 1;
  }

  return [...pairs.values()]
    .filter((entry) => entry.count >= 3)
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix) || a.suffix.localeCompare(b.suffix))
    .slice(0, MAX_TEMPLATE_ENTRIES)
    .map((entry, index) => ({
      template_id: index + 1,
      prefix: entry.prefix,
      suffix: entry.suffix,
      recurrence_count: entry.count,
      artifact_type: entry.artifact_type
    }));
}

function buildLexiconFirstCharMap(lexicon) {
  const map = new Map();

  for (const entry of [...lexicon].sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text))) {
    const key = entry.text[0];
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(entry);
  }

  return map;
}

function chooseTemplate(text, templates) {
  let best = null;
  for (const template of templates) {
    if (
      text.length > template.prefix.length + template.suffix.length &&
      text.startsWith(template.prefix) &&
      text.endsWith(template.suffix)
    ) {
      if (!best || template.prefix.length + template.suffix.length > best.prefix.length + best.suffix.length) {
        best = template;
      }
    }
  }
  return best;
}

function buildDirectRecord(text, template, lexiconFirstCharMap, storeLiteral) {
  const inner = template ? text.slice(template.prefix.length, text.length - template.suffix.length) : text;
  const encoded = encodeSegments(inner, lexiconFirstCharMap, storeLiteral);

  return {
    template_id: template ? template.template_id : null,
    phrase_ids: encoded.phrase_ids,
    literal_spans: encoded.literal_spans,
    segments: encoded.segments,
    base_record: null,
    patch_ops: []
  };
}

function chooseDeltaRecord(targetText, recentRecords, directCost, storeLiteral) {
  let best = null;

  for (const candidate of recentRecords) {
    const prefix = longestCommonPrefix(candidate.text, targetText);
    const suffix = longestCommonSuffix(candidate.text, targetText, prefix);
    const deleteCount = Math.max(0, candidate.text.length - prefix - suffix);
    const insertText = targetText.slice(prefix, targetText.length - suffix);
    const sharedRatio = (prefix + suffix) / Math.max(candidate.text.length, targetText.length, 1);

    if (sharedRatio < 0.55) {
      continue;
    }

    const cost = (insertText ? insertText.length : 0) + 18;

    if (cost >= directCost * 0.8) {
      continue;
    }

    if (!best || cost < best.cost) {
      best = {
        cost,
        candidateRecord: candidate.record,
        prefix,
        deleteCount,
        insertText
      };
    }
  }

  if (!best) {
    return null;
  }

  const insertRef = best.insertText ? storeLiteral(best.insertText) : null;
  return {
    cost: best.cost,
    record: {
      template_id: null,
      phrase_ids: [],
      literal_spans: insertRef ? [insertRef] : [],
      segments: [],
      base_record: best.candidateRecord,
      patch_ops: [{
        op: "replace_range",
        start: best.prefix,
        delete_count: best.deleteCount,
        insert_ref: insertRef
      }]
    }
  };
}

function encodeSegments(text, lexiconFirstCharMap, storeLiteral) {
  const segments = [];
  const phraseIds = [];
  const literalSpans = [];
  let literalStart = 0;
  let cursor = 0;

  function flushLiteral(end) {
    if (end <= literalStart) {
      return;
    }

    const literalText = text.slice(literalStart, end);
    const literalRef = storeLiteral(literalText);
    segments.push({ type: "literal", literal_ref: literalRef });
    literalSpans.push(literalRef);
  }

  while (cursor < text.length) {
    const candidates = lexiconFirstCharMap.get(text[cursor]) || [];
    let matched = null;

    for (const entry of candidates) {
      if (text.startsWith(entry.text, cursor)) {
        matched = entry;
        break;
      }
    }

    if (!matched) {
      cursor += 1;
      continue;
    }

    flushLiteral(cursor);
    segments.push({ type: "phrase", phrase_id: matched.phrase_id });
    phraseIds.push(matched.phrase_id);
    cursor += matched.text.length;
    literalStart = cursor;
  }

  flushLiteral(text.length);

  return {
    segments,
    phrase_ids: phraseIds,
    literal_spans: literalSpans
  };
}

function estimateDirectCost(record) {
  const literalCost = (record.literal_spans || []).reduce((sum, span) => sum + (span.length || 0), 0);
  const phraseCost = (record.phrase_ids || []).length * 6;
  const templateCost = Number.isFinite(record.template_id) ? 4 : 0;
  return literalCost + phraseCost + templateCost + 8;
}

function makeTextRef(record) {
  return {
    mode: "textpack",
    shard: "local_memory/textpack/textpack_000001.bin",
    record
  };
}

