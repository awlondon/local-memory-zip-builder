import { resolveBlockSpeaker } from "./speaker.js";
import { tokenizeForSimilarity } from "./utils.js";

const TIMESTAMP_PATTERN = /\b(?:\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i;

export function parseTextToBlocks(text, onProgress = () => {}) {
  const blocks = [];

  let currentBlock = null;
  let inCodeFence = false;
  let pendingBlankLines = 0;
  let processedChars = 0;
  let lastReported = 0;

  function startBlock(startOffset, type) {
    currentBlock = {
      start_offset: startOffset,
      end_offset: startOffset,
      type,
      leading_blank_lines: pendingBlankLines,
      lines: []
    };
    pendingBlankLines = 0;
  }

  function flushBlock() {
    if (!currentBlock || !currentBlock.lines.length) {
      currentBlock = null;
      return;
    }

    const raw = currentBlock.lines.join("");
    const leadingWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailingWhitespace = raw.match(/\s*$/)?.[0].length ?? 0;
    const trimmed = raw.slice(leadingWhitespace, Math.max(leadingWhitespace, raw.length - trailingWhitespace));

    if (!trimmed) {
      currentBlock = null;
      return;
    }

    const speaker = resolveBlockSpeaker(trimmed, currentBlock.type);

    blocks.push({
      type: currentBlock.type,
      start_offset: currentBlock.start_offset + leadingWhitespace,
      end_offset: currentBlock.end_offset - trailingWhitespace,
      text: trimmed,
      leading_blank_lines: currentBlock.leading_blank_lines,
      speaker_label: speaker.speaker_label,
      speaker_role: speaker.speaker_role,
      speaker_inference_source: speaker.speaker_inference_source,
      speaker_confidence: speaker.speaker_confidence,
      has_timestamp: TIMESTAMP_PATTERN.test(trimmed),
      token_set: tokenizeForSimilarity(trimmed)
    });

    currentBlock = null;
  }

  let cursor = 0;
  while (cursor < text.length) {
    const lineStart = cursor;
    const newlineIndex = text.indexOf("\n", cursor);

    let lineChunk;
    let lineEnd;

    if (newlineIndex === -1) {
      lineChunk = text.slice(cursor);
      lineEnd = text.length;
      cursor = text.length;
    } else {
      lineChunk = text.slice(cursor, newlineIndex + 1);
      lineEnd = newlineIndex + 1;
      cursor = newlineIndex + 1;
    }

    const lineBody = lineChunk.endsWith("\n")
      ? lineChunk.slice(0, lineChunk.endsWith("\r\n") ? -2 : -1)
      : lineChunk;
    const trimmed = lineBody.trim();

    processedChars = lineEnd;
    const shouldReport = processedChars - lastReported > 25000 || processedChars === text.length;
    if (shouldReport) {
      onProgress(Math.min(1, processedChars / Math.max(1, text.length)));
      lastReported = processedChars;
    }

    if (!inCodeFence && trimmed.length === 0) {
      flushBlock();
      pendingBlankLines += 1;
      continue;
    }

    const isFenceLine = /^```/.test(trimmed);

    if (isFenceLine) {
      if (!currentBlock || currentBlock.type !== "code") {
        flushBlock();
        startBlock(lineStart, "code");
      }
      currentBlock.lines.push(lineChunk);
      currentBlock.end_offset = lineEnd;
      inCodeFence = !inCodeFence;
      if (!inCodeFence) {
        flushBlock();
      }
      continue;
    }

    if (inCodeFence) {
      if (!currentBlock || currentBlock.type !== "code") {
        flushBlock();
        startBlock(lineStart, "code");
      }
      currentBlock.lines.push(lineChunk);
      currentBlock.end_offset = lineEnd;
      continue;
    }

    const lineType = classifyLineType(trimmed);

    if (!currentBlock) {
      startBlock(lineStart, lineType);
    } else if (currentBlock.type !== lineType) {
      flushBlock();
      startBlock(lineStart, lineType);
    }

    currentBlock.lines.push(lineChunk);
    currentBlock.end_offset = lineEnd;
  }

  flushBlock();
  onProgress(1);

  return blocks;
}

function classifyLineType(trimmed) {
  if (isTableLine(trimmed)) {
    return "table";
  }

  if (isJsonLikeLine(trimmed)) {
    return "json";
  }

  if (isSectionHeading(trimmed)) {
    return "section";
  }

  if (trimmed.startsWith(">")) {
    return "quote";
  }

  return "paragraph";
}

function isTableLine(text) {
  if (!text) {
    return false;
  }

  if ((text.match(/\|/g) || []).length >= 2) {
    return true;
  }

  if ((text.match(/\t/g) || []).length >= 2) {
    return true;
  }

  return /^[^,]{1,80}(?:,[^,]{1,80}){2,}$/.test(text);
}

function isJsonLikeLine(text) {
  if (!text) {
    return false;
  }

  return (
    /^[\[{]/.test(text) ||
    /^"[^"\n]{1,120}"\s*:/.test(text) ||
    /^(true|false|null|-?\d+(?:\.\d+)?)\s*[,}\]]?$/.test(text)
  );
}

function isSectionHeading(text) {
  if (!text || text.length > 120) {
    return false;
  }

  return (
    /^#{1,6}\s+/.test(text) ||
    /^(chapter|section|part|appendix)\b/i.test(text) ||
    /^[A-Z0-9][A-Z0-9\s:._\-/]{4,90}$/.test(text)
  );
}
