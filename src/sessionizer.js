import { clamp, jaccardFromSets, makeId, safeTitle } from "./utils.js";

const TARGET_SESSION_CHARS = {
  small: 3800,
  medium: 7600,
  large: 13000
};

export function sessionizeBlocks(blocks, fullText, settings, onProgress = () => {}) {
  if (!blocks.length) {
    return [];
  }

  const targetChars = TARGET_SESSION_CHARS[settings.sessionSize] || TARGET_SESSION_CHARS.medium;
  const sessions = [];

  let currentBlocks = [blocks[0]];
  let currentLength = blocks[0].text.length;
  let lastReportedIndex = 0;

  function flushSession() {
    if (!currentBlocks.length) {
      return;
    }

    const startOffset = currentBlocks[0].start_offset;
    const endOffset = currentBlocks[currentBlocks.length - 1].end_offset;
    const sessionIndex = sessions.length + 1;
    const sessionText = fullText.slice(startOffset, endOffset);

    sessions.push({
      session_id: makeId("sess", sessionIndex),
      title: safeTitle(currentBlocks[0].text, `Session ${sessionIndex}`),
      start_offset: startOffset,
      end_offset: endOffset,
      text: sessionText,
      blocks: currentBlocks,
      chunk_ids: [],
      concept_ids: []
    });

    currentBlocks = [];
    currentLength = 0;
  }

  for (let i = 1; i < blocks.length; i += 1) {
    const previous = blocks[i - 1];
    const current = blocks[i];

    const boundary = boundaryScore(previous, current, currentLength, targetChars);
    const hardSplit = currentLength >= targetChars * 1.6;
    const shouldSplit = hardSplit || (boundary >= 0.62 && currentLength >= targetChars * 0.42);

    if (shouldSplit) {
      flushSession();
    }

    currentBlocks.push(current);
    currentLength += current.text.length;

    if (i - lastReportedIndex >= 30 || i === blocks.length - 1) {
      onProgress(clamp(i / Math.max(1, blocks.length - 1), 0, 1));
      lastReportedIndex = i;
    }
  }

  flushSession();
  onProgress(1);

  for (const session of sessions) {
    for (const block of session.blocks) {
      delete block.token_set;
    }
  }

  return sessions;
}

function boundaryScore(previous, current, runningLength, targetChars) {
  let score = 0;

  if (current.leading_blank_lines >= 2) {
    score += 0.2;
  }

  if (previous.has_timestamp || current.has_timestamp) {
    score += 0.16;
  }

  if (previous.speaker_label && current.speaker_label && previous.speaker_label !== current.speaker_label) {
    score += 0.2;
  }

  if (previous.type !== current.type && (previous.type !== "paragraph" || current.type !== "paragraph")) {
    score += 0.14;
  }

  const similarity = jaccardFromSets(previous.token_set, current.token_set);
  if (similarity < 0.06) {
    score += 0.35;
  } else if (similarity < 0.14) {
    score += 0.2;
  } else if (similarity < 0.2) {
    score += 0.1;
  }

  if (runningLength > targetChars * 1.05) {
    score += 0.24;
  }

  if (runningLength > targetChars * 1.3) {
    score += 0.36;
  }

  return score;
}
