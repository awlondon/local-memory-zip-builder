import { clamp, normalizeWhitespace, uniqueStrings } from "./utils.js";

const ROLE_ORDER = ["human", "ai", "system", "tool", "unknown"];
const EXPLICIT_SPEAKER_PATTERN = /^([A-Za-z][A-Za-z0-9_ .\-()]{0,60})\s*:\s+\S/;
const NON_ALTERNATING_BLOCK_TYPES = new Set(["code", "json", "quote", "section"]);

const ROLE_ALIASES = {
  human: ["user", "human", "person", "customer", "client", "altair"],
  ai: ["assistant", "ai", "model", "ankaa", "chatgpt", "gpt"],
  system: ["system"],
  tool: ["tool", "browser", "search", "function", "shell", "mcp"]
};

const METADATA_ROLE_PATTERNS = [
  {
    pattern: /(?:^|[\r\n])\s*"?message\.author\.role"?\s*[:=]\s*"?(?<role>[A-Za-z][A-Za-z0-9_\- ]{0,30})"?/im,
    confidence: 0.95
  },
  {
    pattern: /(?:^|[\r\n])\s*"?author\.role"?\s*[:=]\s*"?(?<role>[A-Za-z][A-Za-z0-9_\- ]{0,30})"?/im,
    confidence: 0.95
  },
  {
    pattern: /(?:^|[\r\n])\s*"?speaker_role"?\s*[:=]\s*"?(?<role>[A-Za-z][A-Za-z0-9_\- ]{0,30})"?/im,
    confidence: 0.92
  },
  {
    pattern: /"author"\s*:\s*\{[\s\S]{0,200}?"role"\s*:\s*"(?<role>[A-Za-z][A-Za-z0-9_\- ]{0,30})"/im,
    confidence: 0.9
  },
  {
    pattern: /(?:^|[\r\n])\s*"?role"?\s*:\s*"?(?<role>user|assistant|human|ai|model|system|tool|browser|search|function|shell|mcp|chatgpt|gpt|altair|ankaa)"?/im,
    confidence: 0.88,
    requiresContext: /author|message|speaker/i
  }
];

export function buildUnknownSpeaker() {
  return {
    speaker_label: null,
    speaker_role: "unknown",
    speaker_inference_source: "unknown",
    speaker_confidence: 0
  };
}

export function resolveBlockSpeaker(text, blockType = "paragraph") {
  const normalizedText = String(text || "");
  const firstLine = normalizedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";

  if (blockType !== "code") {
    const explicitMatch = firstLine.match(EXPLICIT_SPEAKER_PATTERN);
    if (explicitMatch) {
      const label = explicitMatch[1].trim();
      const role = mapSpeakerTokenToRole(label);
      if (role !== "unknown") {
        return {
          speaker_label: label,
          speaker_role: role,
          speaker_inference_source: "explicit_label",
          speaker_confidence: explicitConfidence(label, role)
        };
      }
    }
  }

  const metadataMatch = matchMetadataRole(normalizedText);
  if (metadataMatch) {
    const role = mapSpeakerTokenToRole(metadataMatch.label);
    if (role !== "unknown") {
      return {
        speaker_label: metadataMatch.label,
        speaker_role: role,
        speaker_inference_source: "metadata_pattern",
        speaker_confidence: metadataMatch.confidence
      };
    }
  }

  return buildUnknownSpeaker();
}

export function annotateSessionSpeakerTurns(session) {
  const turns = buildTurns(session.blocks || []);
  const conversationalRuns = splitConversationalRuns(turns);

  for (const run of conversationalRuns) {
    inferConversationalRun(run);
  }

  const dominantHumanLabel = dominantLabel(turns, "human");
  const dominantAiLabel = dominantLabel(turns, "ai");

  for (const turn of turns) {
    for (const block of turn.blocks) {
      block.turn_index = turn.turn_index;
      block.turn_role = turn.speaker_role;

      if (block.speaker_role === "unknown" && turn.speaker_role !== "unknown") {
        block.speaker_role = turn.speaker_role;
        block.speaker_inference_source = turn.speaker_inference_source;
        block.speaker_confidence = turn.speaker_confidence;
      }

      if (!block.speaker_label) {
        if (turn.speaker_inference_source === "explicit_label" || turn.speaker_inference_source === "metadata_pattern") {
          block.speaker_label = turn.speaker_label;
        } else {
          block.speaker_label = null;
        }
      }
    }
  }

  const speakerRoleCounts = countTurnRoles(turns);
  session.turn_count = turns.length;
  session.session_speakers = summarizeSessionSpeakers(turns);
  session.speaker_sequence_preview = buildSequencePreview(turns);
  session.dominant_human_label = dominantHumanLabel;
  session.dominant_ai_label = dominantAiLabel;
  session.speaker_role_counts = speakerRoleCounts;
  session.human_turn_count = speakerRoleCounts.human || 0;
  session.ai_turn_count = speakerRoleCounts.ai || 0;
  session.system_turn_count = speakerRoleCounts.system || 0;
  session.tool_turn_count = speakerRoleCounts.tool || 0;
  session.unknown_turn_count = speakerRoleCounts.unknown || 0;
  session.ai_turn_ratio = session.turn_count ? roundConfidence((speakerRoleCounts.ai || 0) / session.turn_count) : 0;
  session.speaker_profile = deriveSpeakerProfile(speakerRoleCounts);

  if (!session.dominant_human_label && session.human_turn_count) {
    session.dominant_human_label = null;
  }
  if (!session.dominant_ai_label && session.ai_turn_count) {
    session.dominant_ai_label = null;
  }

  return session;
}

export function summarizeChunkSpeaker(units) {
  const orderedTurns = [];
  const seenTurnKeys = new Set();

  for (const unit of units) {
    const role = unit.turn_role || unit.speaker_role || "unknown";
    const label = unit.speaker_label || null;
    const turnIndex = Number.isFinite(unit.turn_index) ? unit.turn_index : null;
    const key = `${turnIndex ?? `u-${orderedTurns.length}`}:${role}:${label || ""}`;

    if (seenTurnKeys.has(key)) {
      continue;
    }

    seenTurnKeys.add(key);
    orderedTurns.push({
      turn_index: turnIndex,
      speaker_role: role,
      speaker_label: label
    });
  }

  const turnCount = uniqueTurnCount(units);
  const preview = buildSequencePreview(orderedTurns);
  const candidates = collectSpeakerCandidates(units);
  const roleSet = uniqueStrings(candidates.map((candidate) => candidate.role).filter((role) => role !== "unknown"));
  const labelSet = uniqueStrings(candidates.map((candidate) => candidate.label));
  const turnRoleSet = uniqueStrings(units.map((unit) => unit.turn_role).filter(Boolean));
  const turnIndices = uniqueStrings(
    units
      .map((unit) => (Number.isFinite(unit.turn_index) ? String(unit.turn_index) : ""))
      .filter(Boolean)
  );
  const best = pickBestCandidate(candidates);

  if (!roleSet.length) {
    return {
      speaker_role: "unknown",
      speaker_label: null,
      speaker_inference_source: "unknown",
      speaker_confidence: 0,
      turn_index: turnIndices.length === 1 ? Number(turnIndices[0]) : null,
      turn_role: turnRoleSet.length === 1 ? turnRoleSet[0] : "unknown",
      turn_count: Math.max(1, turnCount),
      speaker_sequence_preview: preview
    };
  }

  if (roleSet.length === 1) {
    return {
      speaker_role: roleSet[0],
      speaker_label: labelSet.length === 1 ? labelSet[0] : (best?.label || null),
      speaker_inference_source: best?.source || "unknown",
      speaker_confidence: best?.confidence || 0,
      turn_index: turnIndices.length === 1 ? Number(turnIndices[0]) : null,
      turn_role: turnRoleSet.length === 1 ? turnRoleSet[0] : roleSet[0],
      turn_count: Math.max(1, turnCount),
      speaker_sequence_preview: preview
    };
  }

  return {
    speaker_role: "mixed",
    speaker_label: null,
    speaker_inference_source: "unknown",
    speaker_confidence: 0.35,
    turn_index: null,
    turn_role: null,
    turn_count: Math.max(2, turnCount),
    speaker_sequence_preview: preview
  };
}

export function isSpeakerSwitch(previous, current) {
  if (!previous || !current) {
    return false;
  }

  if (
    Number.isFinite(previous.turn_index) &&
    Number.isFinite(current.turn_index) &&
    previous.turn_index !== current.turn_index
  ) {
    return true;
  }

  const previousRole = previous.turn_role || previous.speaker_role || "unknown";
  const currentRole = current.turn_role || current.speaker_role || "unknown";
  if (previousRole !== "unknown" && currentRole !== "unknown" && previousRole !== currentRole) {
    return true;
  }

  return Boolean(previous.speaker_label && current.speaker_label && previous.speaker_label !== current.speaker_label);
}

export function buildSpeakerSignature(record) {
  return [
    record.speaker_role || "unknown",
    record.speaker_label || "",
    record.speaker_inference_source || "unknown",
    roundConfidence(record.speaker_confidence || 0),
    Number.isFinite(record.turn_index) ? record.turn_index : "",
    record.turn_role || "",
    Number.isFinite(record.turn_count) ? record.turn_count : "",
    record.speaker_sequence_preview || ""
  ].join("|");
}

function matchMetadataRole(text) {
  for (const entry of METADATA_ROLE_PATTERNS) {
    if (entry.requiresContext && !entry.requiresContext.test(text)) {
      continue;
    }

    const match = text.match(entry.pattern);
    const label = match?.groups?.role || match?.[1] || null;
    if (!label) {
      continue;
    }

    return {
      label: label.trim(),
      confidence: metadataConfidence(label, entry.confidence)
    };
  }

  return null;
}

function buildTurns(blocks) {
  const turns = [];
  let currentTurn = null;

  for (const block of blocks) {
    if (block.type === "section") {
      block.turn_index = null;
      block.turn_role = null;
      continue;
    }

    if (!currentTurn || shouldStartNewTurn(currentTurn, block)) {
      currentTurn = {
        turn_index: turns.length + 1,
        blocks: [],
        speaker_label: null,
        speaker_role: "unknown",
        speaker_inference_source: "unknown",
        speaker_confidence: 0,
        contains_structural_break: false
      };
      turns.push(currentTurn);
    }

    currentTurn.blocks.push(block);
    currentTurn.contains_structural_break = currentTurn.contains_structural_break || block.has_timestamp || block.type === "section";
    const resolved = resolveTurnSpeakerFromBlocks(currentTurn.blocks);
    currentTurn.speaker_label = resolved.speaker_label;
    currentTurn.speaker_role = resolved.speaker_role;
    currentTurn.speaker_inference_source = resolved.speaker_inference_source;
    currentTurn.speaker_confidence = resolved.speaker_confidence;
  }

  return turns;
}

function shouldStartNewTurn(currentTurn, nextBlock) {
  const previousBlock = currentTurn.blocks[currentTurn.blocks.length - 1];
  if (!previousBlock) {
    return true;
  }

  if (nextBlock.leading_blank_lines >= 1) {
    return true;
  }

  if (previousBlock.has_timestamp || nextBlock.has_timestamp) {
    return true;
  }

  if (previousBlock.type === "section" || nextBlock.type === "section") {
    return true;
  }

  if (hasStrongSpeakerChange(previousBlock, nextBlock)) {
    return true;
  }

  return false;
}

function hasStrongSpeakerChange(previousBlock, nextBlock) {
  const previousRole = previousBlock.speaker_role || "unknown";
  const nextRole = nextBlock.speaker_role || "unknown";

  if (previousRole !== "unknown" && nextRole !== "unknown" && previousRole !== nextRole) {
    return true;
  }

  return Boolean(
    previousBlock.speaker_label &&
    nextBlock.speaker_label &&
    previousBlock.speaker_label !== nextBlock.speaker_label
  );
}

function resolveTurnSpeakerFromBlocks(blocks) {
  const candidates = collectSpeakerCandidates(blocks);
  const best = pickBestCandidate(candidates);

  if (!best) {
    return buildUnknownSpeaker();
  }

  const conflictingRoles = uniqueStrings(
    candidates
      .filter((candidate) => candidate.confidence >= Math.max(0.72, best.confidence - 0.08))
      .map((candidate) => candidate.role)
  );

  if (conflictingRoles.length > 1 && best.confidence < 0.94) {
    return buildUnknownSpeaker();
  }

  return {
    speaker_label: best.label || null,
    speaker_role: best.role,
    speaker_inference_source: best.source,
    speaker_confidence: best.confidence
  };
}

function splitConversationalRuns(turns) {
  const runs = [];
  let currentRun = [];

  for (const turn of turns) {
    if (!isConversationalCandidate(turn)) {
      if (currentRun.length) {
        runs.push(currentRun);
        currentRun = [];
      }
      continue;
    }

    if (turn.contains_structural_break && currentRun.length) {
      runs.push(currentRun);
      currentRun = [];
    }

    currentRun.push(turn);
  }

  if (currentRun.length) {
    runs.push(currentRun);
  }

  return runs;
}

function isConversationalCandidate(turn) {
  if (!turn || turn.speaker_role === "system" || turn.speaker_role === "tool") {
    return false;
  }

  return turn.blocks.some((block) => !NON_ALTERNATING_BLOCK_TYPES.has(block.type));
}

function inferConversationalRun(run) {
  if (!run.length) {
    return;
  }

  const anchors = [];
  for (let index = 0; index < run.length; index += 1) {
    if (isConversationalRole(run[index].speaker_role)) {
      anchors.push(index);
    }
  }

  let parityEstablished = false;

  for (let i = 0; i < anchors.length - 1; i += 1) {
    const leftIndex = anchors[i];
    const rightIndex = anchors[i + 1];
    const leftRole = run[leftIndex].speaker_role;
    const rightRole = run[rightIndex].speaker_role;
    const distance = rightIndex - leftIndex;

    if (!parityMatches(leftRole, rightRole, distance)) {
      continue;
    }

    parityEstablished = true;
    for (let offset = 1; offset < distance; offset += 1) {
      const turn = run[leftIndex + offset];
      if (turn.speaker_role !== "unknown") {
        continue;
      }

      assignInferredTurn(
        turn,
        offset % 2 === 1 ? oppositeRole(leftRole) : leftRole,
        "turn_alternation",
        alternationConfidence(Math.min(offset, distance - offset))
      );
    }
  }

  if (anchors.length === 0) {
    seedSessionDefault(run, 0, "human");
    return;
  }

  if (anchors.length === 1) {
    extendFromAnchor(run, anchors[0], "session_default");
    return;
  }

  if (parityEstablished) {
    extendAlternationEdges(run);
    return;
  }

  extendFromAnchor(run, anchors[0], "session_default");
}

function extendAlternationEdges(run) {
  let lastKnownIndex = -1;

  for (let index = 0; index < run.length; index += 1) {
    const turn = run[index];
    if (isConversationalRole(turn.speaker_role)) {
      lastKnownIndex = index;
      continue;
    }

    if (lastKnownIndex === -1) {
      continue;
    }

    assignInferredTurn(
      turn,
      oppositeRole(run[lastKnownIndex].speaker_role),
      "turn_alternation",
      chainedConfidence(run[lastKnownIndex].speaker_confidence, 0.7, 0.45)
    );
    lastKnownIndex = index;
  }

  let nextKnownIndex = -1;
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const turn = run[index];
    if (isConversationalRole(turn.speaker_role)) {
      nextKnownIndex = index;
      continue;
    }

    if (nextKnownIndex === -1) {
      continue;
    }

    assignInferredTurn(
      turn,
      oppositeRole(run[nextKnownIndex].speaker_role),
      "turn_alternation",
      chainedConfidence(run[nextKnownIndex].speaker_confidence, 0.66, 0.45)
    );
    nextKnownIndex = index;
  }
}

function extendFromAnchor(run, anchorIndex, source) {
  for (let index = anchorIndex + 1; index < run.length; index += 1) {
    if (run[index].speaker_role !== "unknown") {
      continue;
    }

    assignInferredTurn(
      run[index],
      oppositeRole(run[index - 1].speaker_role),
      source,
      chainedConfidence(run[index - 1].speaker_confidence, source === "turn_alternation" ? 0.7 : 0.55, 0.35)
    );
  }

  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    if (run[index].speaker_role !== "unknown") {
      continue;
    }

    assignInferredTurn(
      run[index],
      oppositeRole(run[index + 1].speaker_role),
      source,
      chainedConfidence(run[index + 1].speaker_confidence, source === "turn_alternation" ? 0.66 : 0.5, 0.35)
    );
  }
}

function seedSessionDefault(run, startIndex, startRole) {
  if (run.length < 2) {
    return;
  }

  let role = startRole;
  let confidence = 0.55;
  for (let index = startIndex; index < run.length; index += 1) {
    if (run[index].speaker_role === "unknown") {
      assignInferredTurn(run[index], role, "session_default", confidence);
    } else {
      role = run[index].speaker_role;
      confidence = run[index].speaker_confidence || 0.55;
    }

    role = oppositeRole(role);
    confidence = chainedConfidence(confidence, 0.55, 0.35);
  }
}

function assignInferredTurn(turn, role, source, confidence) {
  if (!turn || turn.speaker_role !== "unknown" || !isConversationalRole(role)) {
    return;
  }

  turn.speaker_role = role;
  turn.speaker_label = null;
  turn.speaker_inference_source = source;
  turn.speaker_confidence = roundConfidence(confidence);
}

function collectSpeakerCandidates(items) {
  return items
    .map((item) => ({
      role: item.speaker_role || "unknown",
      label: item.speaker_label || null,
      source: item.speaker_inference_source || "unknown",
      confidence: roundConfidence(item.speaker_confidence || 0),
      turn_role: item.turn_role || item.speaker_role || "unknown"
    }))
    .filter((candidate) => candidate.role !== "unknown");
}

function pickBestCandidate(candidates) {
  if (!candidates.length) {
    return null;
  }

  return [...candidates].sort((left, right) => (
    right.confidence - left.confidence ||
    sourceRank(right.source) - sourceRank(left.source) ||
    labelScore(right.label) - labelScore(left.label) ||
    left.role.localeCompare(right.role)
  ))[0];
}

function summarizeSessionSpeakers(turns) {
  const summaries = new Map();

  for (const turn of turns) {
    const role = turn.speaker_role || "unknown";
    if (!summaries.has(role)) {
      summaries.set(role, {
        speaker_role: role,
        turn_count: 0,
        block_count: 0,
        labels: []
      });
    }

    const entry = summaries.get(role);
    entry.turn_count += 1;
    entry.block_count += turn.blocks.length;
    if (turn.speaker_label) {
      entry.labels.push(turn.speaker_label);
    }
  }

  return [...summaries.values()]
    .map((entry) => ({
      ...entry,
      labels: uniqueStrings(entry.labels)
    }))
    .sort((left, right) => roleSort(left.speaker_role) - roleSort(right.speaker_role));
}

function countTurnRoles(turns) {
  const counts = {
    human: 0,
    ai: 0,
    system: 0,
    tool: 0,
    unknown: 0
  };

  for (const turn of turns) {
    const role = turn.speaker_role || "unknown";
    counts[role] = (counts[role] || 0) + 1;
  }

  return counts;
}

function dominantLabel(turns, role) {
  const counts = new Map();

  for (const turn of turns) {
    if (turn.speaker_role !== role || !turn.speaker_label) {
      continue;
    }
    counts.set(turn.speaker_label, (counts.get(turn.speaker_label) || 0) + 1);
  }

  const entries = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return entries[0]?.[0] || null;
}

function deriveSpeakerProfile(counts) {
  const hasHuman = (counts.human || 0) > 0;
  const hasAi = (counts.ai || 0) > 0;
  const hasSystem = (counts.system || 0) > 0;
  const hasTool = (counts.tool || 0) > 0;

  if (hasHuman && hasAi) {
    return "mixed";
  }

  if (hasHuman && !hasAi && !hasSystem && !hasTool) {
    return "human_only";
  }

  if (hasAi && !hasHuman && !hasSystem && !hasTool) {
    return "ai_only";
  }

  if (hasHuman || hasAi || hasSystem || hasTool) {
    return "mixed";
  }

  return "unknown";
}

function buildSequencePreview(entries) {
  const sequence = [];

  for (const entry of entries.slice(0, 8)) {
    const role = entry.speaker_role || "unknown";
    const label = entry.speaker_label ? `(${entry.speaker_label})` : "";
    const value = `${role}${label}`;
    if (sequence[sequence.length - 1] !== value) {
      sequence.push(value);
    }
  }

  return sequence.join(" -> ");
}

function uniqueTurnCount(units) {
  const knownTurns = new Set();
  let anonymousTurnCount = 0;

  for (const unit of units) {
    if (Number.isFinite(unit.turn_index)) {
      knownTurns.add(unit.turn_index);
    } else {
      anonymousTurnCount += 1;
    }
  }

  return knownTurns.size || anonymousTurnCount || 0;
}

function roleSort(role) {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

function parityMatches(leftRole, rightRole, distance) {
  if (!isConversationalRole(leftRole) || !isConversationalRole(rightRole) || distance <= 0) {
    return false;
  }

  const shouldMatch = distance % 2 === 0;
  return shouldMatch ? leftRole === rightRole : leftRole !== rightRole;
}

function isConversationalRole(role) {
  return role === "human" || role === "ai";
}

function oppositeRole(role) {
  return role === "ai" ? "human" : "ai";
}

function chainedConfidence(previousConfidence, base, floor) {
  const seed = Number.isFinite(previousConfidence) ? previousConfidence : base;
  return roundConfidence(clamp(seed - 0.08, floor, base));
}

function alternationConfidence(distance) {
  return roundConfidence(clamp(0.74 - (Math.max(1, distance) - 1) * 0.06, 0.52, 0.74));
}

function explicitConfidence(label, role) {
  const normalized = normalizeSpeakerToken(label);
  if (normalized === role || canonicalRoleLabel(role).includes(normalized)) {
    return 0.98;
  }

  if (knownAlias(role, normalized)) {
    return 0.9;
  }

  return 0.88;
}

function metadataConfidence(label, baseConfidence) {
  const role = mapSpeakerTokenToRole(label);
  if (role === "unknown") {
    return 0;
  }

  const normalized = normalizeSpeakerToken(label);
  const confidence = canonicalRoleLabel(role).includes(normalized)
    ? baseConfidence
    : knownAlias(role, normalized)
      ? Math.min(baseConfidence, 0.9)
      : baseConfidence;
  return roundConfidence(confidence);
}

function canonicalRoleLabel(role) {
  if (role === "human") {
    return ["user", "human"];
  }

  if (role === "ai") {
    return ["assistant", "ai"];
  }

  if (role === "system") {
    return ["system"];
  }

  if (role === "tool") {
    return ["tool"];
  }

  return [];
}

function knownAlias(role, normalizedLabel) {
  return ROLE_ALIASES[role]?.includes(normalizedLabel) || false;
}

function mapSpeakerTokenToRole(value) {
  const normalized = normalizeSpeakerToken(value);
  if (!normalized) {
    return "unknown";
  }

  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) {
    if (aliases.includes(normalized)) {
      return role;
    }

    const tokenParts = normalized.split(" ");
    if (tokenParts.some((part) => aliases.includes(part))) {
      return role;
    }
  }

  if (/^gpt(?:[- ]?\d+(?:\.\d+)?)?$/.test(normalized)) {
    return "ai";
  }

  return "unknown";
}

function normalizeSpeakerToken(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/["'`[\]{}()]/g, "")
    .replace(/[._\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceRank(source) {
  switch (source) {
    case "explicit_label":
      return 4;
    case "metadata_pattern":
      return 3;
    case "turn_alternation":
      return 2;
    case "session_default":
      return 1;
    default:
      return 0;
  }
}

function labelScore(label) {
  return label ? 1 : 0;
}

function roundConfidence(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
