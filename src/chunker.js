import { clamp, makeId, normalizeWhitespace, splitSentencesWithOffsets } from "./utils.js";

const CHUNK_SIZE_PROFILE = {
  small: { min: 120, target: 250, max: 420 },
  medium: { min: 170, target: 390, max: 650 },
  large: { min: 220, target: 530, max: 860 }
};

export function chunkSessions(sessions, settings, onProgress = () => {}) {
  const profile = CHUNK_SIZE_PROFILE[settings.sessionSize] || CHUNK_SIZE_PROFILE.medium;
  const chunks = [];
  let chunkCounter = 1;

  for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
    const session = sessions[sessionIndex];
    const units = unitsFromSessionBlocks(session.blocks, profile);

    let currentUnits = [];
    let currentLength = 0;
    let sequence = 1;

    function flushChunk() {
      if (!currentUnits.length) {
        return;
      }

      const start = currentUnits[0].start_offset;
      const end = currentUnits[currentUnits.length - 1].end_offset;
      const text = normalizeWhitespace(currentUnits.map((unit) => unit.text).join(" "));

      if (!text) {
        currentUnits = [];
        currentLength = 0;
        return;
      }

      const chunkId = makeId("chunk", chunkCounter++);
      const chunk = {
        chunk_id: chunkId,
        session_id: session.session_id,
        seq_in_session: sequence,
        start_offset: start,
        end_offset: end,
        text,
        kind: classifyChunk(text, currentUnits)
      };

      chunks.push(chunk);
      session.chunk_ids.push(chunkId);

      sequence += 1;
      currentUnits = [];
      currentLength = 0;
    }

    for (const unit of units) {
      const unitLength = unit.text.length;
      const overflow = currentLength + unitLength > profile.max;
      const boundaryCue = looksLikeBoundary(unit.text);
      const enoughToFlush = currentLength >= profile.min;

      if (currentUnits.length && overflow && enoughToFlush) {
        flushChunk();
      }

      if (currentUnits.length && boundaryCue && currentLength >= Math.round(profile.min * 0.7)) {
        flushChunk();
      }

      currentUnits.push(unit);
      currentLength += unitLength;

      if (currentLength >= profile.target && looksComplete(currentUnits[currentUnits.length - 1].text)) {
        flushChunk();
      }
    }

    flushChunk();

    onProgress(clamp((sessionIndex + 1) / Math.max(1, sessions.length), 0, 1));
  }

  return chunks;
}

function unitsFromSessionBlocks(blocks, profile) {
  const units = [];

  for (const block of blocks) {
    const text = normalizeWhitespace(block.text);
    if (!text) {
      continue;
    }

    if (block.type === "code" || block.type === "quote" || text.length <= profile.target * 1.5) {
      units.push({
        text,
        start_offset: block.start_offset,
        end_offset: block.end_offset,
        block_type: block.type
      });
      continue;
    }

    const sentenceUnits = splitSentencesWithOffsets(block.text, block.start_offset);

    for (const sentenceUnit of sentenceUnits) {
      units.push({
        text: sentenceUnit.text,
        start_offset: sentenceUnit.start_offset,
        end_offset: sentenceUnit.end_offset,
        block_type: block.type
      });
    }
  }

  return units;
}

function classifyChunk(text, units) {
  const lower = text.toLowerCase();

  if (/\b(error|failed|failure|exception|traceback|bug)\b/.test(lower)) {
    return "error";
  }

  if (/\b(decision|decide|decided|approved|final|resolved|ship(?:ped)?)\b/.test(lower)) {
    return "decision";
  }

  if (/\b(please|could you|can you|would you|need to|request|ask)\b/.test(lower)) {
    return "request";
  }

  if (/\b(todo|next step|action item|follow up)\b/.test(lower)) {
    return "task";
  }

  if (units.some((unit) => unit.block_type === "quote") || /"[^"]+"|'[^']+'/.test(text)) {
    return "quote";
  }

  if (/\b(is|means|defined as|consists of)\b/.test(lower)) {
    return "fact";
  }

  return "statement";
}

function looksLikeBoundary(text) {
  const lower = text.toLowerCase();
  return /\b(however|therefore|in summary|finally|next,|next step|conclusion)\b/.test(lower);
}

function looksComplete(text) {
  return /[.!?)]$/.test(text.trim());
}
