import { tokenizeForSimilarity } from "./utils.js";

const SPEAKER_PATTERN = /^([A-Za-z][A-Za-z0-9_ .\-]{0,40}):\s/;
const TIMESTAMP_PATTERN = /\b(?:\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i;

export function parseTextToBlocks(text, onProgress = () => {}) {
  const blocks = [];
  const linePattern = /.*(?:\r\n|\n|$)/g;

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

    const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
    const speakerMatch = firstLine.match(SPEAKER_PATTERN);

    blocks.push({
      type: currentBlock.type,
      start_offset: currentBlock.start_offset + leadingWhitespace,
      end_offset: currentBlock.end_offset - trailingWhitespace,
      text: trimmed,
      leading_blank_lines: currentBlock.leading_blank_lines,
      speaker_label: speakerMatch ? speakerMatch[1].trim() : null,
      has_timestamp: TIMESTAMP_PATTERN.test(trimmed),
      token_set: tokenizeForSimilarity(trimmed)
    });

    currentBlock = null;
  }

  let match;
  while ((match = linePattern.exec(text)) !== null) {
    const lineChunk = match[0];
    if (!lineChunk && linePattern.lastIndex >= text.length) {
      break;
    }

    const lineStart = match.index;
    const lineEnd = lineStart + lineChunk.length;
    const lineBody = lineChunk.replace(/[\r\n]+$/, "");
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

    const lineType = trimmed.startsWith(">") ? "quote" : "paragraph";

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
