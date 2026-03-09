import { normalizeConceptKey, normalizeWhitespace, stableHash, tokenizeWithoutStopWords } from "./utils.js";

const MAX_OBSESSIONS = 9;
const MAX_THREADS_PER_OBSESSION = 4;
const MAX_GRAPH_THREADS = 18;

const DISCOURAGED_LABELS = new Set([
  "assistant",
  "assistants",
  "chatgpt",
  "chunk",
  "chunks",
  "concept",
  "concepts",
  "conversation",
  "conversations",
  "file",
  "files",
  "json",
  "local memory",
  "manifest",
  "message",
  "messages",
  "prompt",
  "prompts",
  "session",
  "sessions",
  "text",
  "textpack",
  "thread",
  "threads",
  "user",
  "users"
]);

const GLYPHS = ["<>", "[]", "::", "//", "##", "{}", "++", "**", "=="];
const ACCENTS = [
  "#ff7a59",
  "#1a6b8a",
  "#f2b134",
  "#1f8f5f",
  "#c85c8e",
  "#5d5fef",
  "#b86128",
  "#2b4c7e",
  "#75814b"
];
const THREAD_MARKS = ["o", "+", "x", "*", "=", "#", "~", ":"];

export function buildCoreObsessionsArtifact(payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const concepts = Array.isArray(payload.concepts) ? payload.concepts : [];
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  const inputFileName = String(payload.inputFileName || "local-memory");
  const symbolicEnabled = payload.symbolicEnabled !== false;

  const data = buildArtifactData({
    inputFileName,
    sessions,
    concepts,
    chunks,
    symbolicEnabled
  });

  return [
    {
      path: "core-obsessions-graph.html",
      content: buildHtmlTemplate(data)
    },
    {
      path: "core-obsessions-graph.css",
      content: buildCssTemplate()
    },
    {
      path: "core-obsessions-graph.js",
      content: buildJsTemplate()
    },
    {
      path: "core-obsessions-graph.data.json",
      content: JSON.stringify(data, null, 2)
    }
  ];
}

function buildArtifactData({ inputFileName, sessions, concepts, chunks, symbolicEnabled }) {
  const conceptMeta = buildConceptMeta(concepts, sessions);
  const obsessions = selectObsessions(conceptMeta);
  const threadEntries = [];
  const graphThreadIds = [];
  const sessionRawTextById = buildSessionRawTextMap(chunks);

  for (let index = 0; index < obsessions.length; index += 1) {
    const obsession = obsessions[index];
    obsession.glyph = GLYPHS[index % GLYPHS.length];
    obsession.accent = ACCENTS[index % ACCENTS.length];
    obsession.thread_ids = [];

    const topSessions = rankSessionsForConcept(obsession, sessions).slice(0, MAX_THREADS_PER_OBSESSION);
    for (let sessionIndex = 0; sessionIndex < topSessions.length; sessionIndex += 1) {
      const session = topSessions[sessionIndex];
      const threadId = `thread_${threadEntries.length + 1}`;
      const threadEntry = {
        id: threadId,
        concept_id: obsession.id,
        concept_label: obsession.label,
        session_id: session.session_id,
        title: session.title || session.session_id,
        chunk_count: Array.isArray(session.chunk_ids) ? session.chunk_ids.length : Number(session.chunk_count) || 0,
        turn_count: Number(session.turn_count) || 0,
        speaker_profile: session.speaker_profile || "unknown",
        dominant_human_label: session.dominant_human_label || null,
        dominant_ai_label: session.dominant_ai_label || null,
        start_offset: Number(session.start_offset) || 0,
        end_offset: Number(session.end_offset) || 0,
        score: Number(session.__obsessionScore.toFixed(4)),
        symbolic_path: symbolicEnabled ? `local_memory/symbolic/${session.session_id}.stream.jsonl` : null,
        marker: THREAD_MARKS[(threadEntries.length + sessionIndex) % THREAD_MARKS.length],
        raw_text: sessionRawTextById.get(session.session_id) || null
      };

      obsession.thread_ids.push(threadId);
      threadEntries.push(threadEntry);

      if (graphThreadIds.length < MAX_GRAPH_THREADS) {
        graphThreadIds.push(threadId);
      }
    }
  }

  return {
    generated_from: inputFileName,
    symbolic_enabled: symbolicEnabled,
    profile: {
      title: buildProfileTitle(inputFileName),
      subtitle: buildProfileSubtitle(obsessions.length, sessions.length),
      summary: buildProfileSummary(obsessions)
    },
    stats: {
      obsession_count: obsessions.length,
      session_count: sessions.length,
      concept_count: concepts.length,
      threaded_evidence_count: threadEntries.length
    },
    obsessions: obsessions.map((obsession) => ({
      id: obsession.id,
      label: obsession.label,
      normalized_label: obsession.normalized_label,
      importance: obsession.importance,
      recurrence_count: obsession.recurrence_count,
      session_count: obsession.session_count,
      chunk_count: obsession.chunk_count,
      score: obsession.score,
      glyph: obsession.glyph,
      accent: obsession.accent,
      aliases: obsession.aliases,
      thread_ids: obsession.thread_ids
    })),
    threads: threadEntries,
    graph_thread_ids: graphThreadIds
  };
}

function buildConceptMeta(concepts, sessions) {
  const sessionCountByConceptId = new Map();
  for (const session of sessions) {
    for (const conceptId of session.concept_ids || []) {
      sessionCountByConceptId.set(conceptId, (sessionCountByConceptId.get(conceptId) || 0) + 1);
    }
  }

  let maxRecurrence = 1;
  let maxSessionCount = 1;

  const meta = concepts
    .map((concept) => {
      const sessionCount = sessionCountByConceptId.get(concept.concept_id) || 0;
      const recurrenceCount = Number(concept.recurrence_count) || 0;
      const chunkCount = Array.isArray(concept.chunk_ids) ? concept.chunk_ids.length : 0;
      const normalizedLabel = normalizeConceptKey(concept.label);

      maxRecurrence = Math.max(maxRecurrence, recurrenceCount);
      maxSessionCount = Math.max(maxSessionCount, sessionCount);

      return {
        id: concept.concept_id,
        label: normalizeWhitespace(concept.label),
        normalized_label: normalizedLabel,
        aliases: Array.isArray(concept.aliases) ? concept.aliases.filter(Boolean).slice(0, 2) : [],
        importance: Number(concept.importance) || 0,
        recurrence_count: recurrenceCount,
        session_count: sessionCount,
        chunk_count: chunkCount
      };
    })
    .filter((concept) => isUsefulConcept(concept.label, concept.normalized_label));

  for (const concept of meta) {
    const recurrenceScore = concept.recurrence_count / maxRecurrence;
    const sessionScore = concept.session_count / maxSessionCount;
    const wordCount = tokenizeWithoutStopWords(concept.label).length;
    const structureBonus = wordCount >= 2 ? 0.08 : 0;

    concept.score = Number(
      Math.min(
        1,
        concept.importance * 0.56 +
        recurrenceScore * 0.24 +
        sessionScore * 0.2 +
        structureBonus
      ).toFixed(4)
    );
  }

  meta.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.session_count !== left.session_count) {
      return right.session_count - left.session_count;
    }
    return left.label.localeCompare(right.label);
  });

  return meta;
}

function selectObsessions(concepts) {
  const selected = [];

  for (const concept of concepts) {
    const isNearDuplicate = selected.some((candidate) =>
      concept.normalized_label === candidate.normalized_label ||
      tokenOverlap(concept.label, candidate.label) >= 0.72
    );

    if (isNearDuplicate) {
      continue;
    }

    selected.push({ ...concept });
    if (selected.length >= MAX_OBSESSIONS) {
      break;
    }
  }

  return selected;
}

function rankSessionsForConcept(concept, sessions) {
  const conceptNeedle = concept.normalized_label;
  const ranked = [];

  for (const session of sessions) {
    if (!(session.concept_ids || []).includes(concept.id)) {
      continue;
    }

    const normalizedTitle = normalizeConceptKey(session.title || "");
    const titleHit = normalizedTitle.includes(conceptNeedle) ? 0.35 : 0;
    const turnScore = Math.min(1, (Number(session.turn_count) || 0) / 12);
    const chunkScore = Math.min(1, ((session.chunk_ids || []).length || Number(session.chunk_count) || 0) / 8);
    const hasHuman = session.has_human || (Number(session.human_turn_count) || 0) > 0;
    const hasAi = session.has_ai || (Number(session.ai_turn_count) || 0) > 0;
    const speakerBonus = hasHuman && hasAi ? 0.08 : 0;

    ranked.push({
      ...session,
      __obsessionScore: titleHit + turnScore * 0.32 + chunkScore * 0.25 + speakerBonus
    });
  }

  ranked.sort((left, right) => {
    if (right.__obsessionScore !== left.__obsessionScore) {
      return right.__obsessionScore - left.__obsessionScore;
    }
    if ((right.turn_count || 0) !== (left.turn_count || 0)) {
      return (right.turn_count || 0) - (left.turn_count || 0);
    }
    return String(left.title || "").localeCompare(String(right.title || ""));
  });

  return ranked;
}

function isUsefulConcept(label, normalizedLabel) {
  if (!label || normalizedLabel.length < 3) {
    return false;
  }

  if (DISCOURAGED_LABELS.has(normalizedLabel)) {
    return false;
  }

  if (/^\d+$/.test(normalizedLabel)) {
    return false;
  }

  const tokenCount = tokenizeWithoutStopWords(label).length;
  if (tokenCount === 0 || tokenCount > 6) {
    return false;
  }

  return true;
}

function tokenOverlap(left, right) {
  const leftTokens = new Set(tokenizeWithoutStopWords(left));
  const rightTokens = new Set(tokenizeWithoutStopWords(right));

  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildProfileTitle(inputFileName) {
  const base = String(inputFileName || "local-memory").replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").trim();
  return base ? `${base} core obsessions` : "Core obsessions";
}

function buildProfileSubtitle(obsessionCount, sessionCount) {
  return `${obsessionCount} obsessions distilled from ${sessionCount} sessions`;
}

function buildProfileSummary(obsessions) {
  if (!obsessions.length) {
    return "The archive did not yield enough stable recurring concepts to build a graph.";
  }

  const leadLabels = obsessions.slice(0, 3).map((obsession) => obsession.label);
  return `This graph foregrounds the recurring motifs that appear most persistently across the archive, starting with ${leadLabels.join(", ")}.`;
}

function buildHtmlTemplate(data) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Core Obsessions Graph</title>
  <link rel="stylesheet" href="./core-obsessions-graph.css">
</head>
<body>
  <main class="shell">
    <section class="stage-card">
      <div class="stage-copy">
        <p class="eyebrow">Archive companion artifact</p>
        <h1 id="profile-title">Core Obsessions</h1>
        <p id="profile-subtitle" class="subtitle"></p>
        <p id="profile-summary" class="summary"></p>
      </div>
      <div class="toolbar">
        <button id="drift-toggle" class="toolbar-button" type="button" aria-pressed="true">Drift on</button>
        <button id="reset-button" class="toolbar-button" type="button">Reset focus</button>
      </div>
      <div id="graph-stage" class="graph-stage" aria-label="Core obsessions graph"></div>
    </section>

    <section class="panel-grid">
      <aside class="panel detail-panel">
        <p class="panel-label">Selection</p>
        <h2 id="detail-title">Choose a node</h2>
        <p id="detail-meta" class="detail-meta">Select an obsession or thread to inspect its archive evidence.</p>
        <p id="detail-body" class="detail-body"></p>
      </aside>

      <section class="panel thread-panel">
        <div class="panel-header">
          <div>
            <p class="panel-label">Thread explorer</p>
            <h2 id="thread-panel-title">Archive evidence</h2>
          </div>
          <p id="thread-panel-meta" class="panel-meta"></p>
        </div>
        <div id="thread-list" class="thread-list"></div>
        <article class="thread-viewer">
          <div class="thread-viewer-header">
            <h3 id="thread-viewer-title">Raw text reconstruction</h3>
            <p id="thread-viewer-meta" class="panel-meta">Select a thread and reconstruct it from symbolic plus textpack shards.</p>
          </div>
          <pre id="thread-raw-text" class="thread-raw-text">No thread reconstructed yet.</pre>
        </article>
      </section>
    </section>
  </main>

  <script id="core-obsessions-graph-data" type="application/json">${serializeForInlineScript(data)}</script>
  <script type="module" src="./core-obsessions-graph.js"></script>
</body>
</html>
`;
}

function buildCssTemplate() {
  return `:root {
  --bg: #f5efe4;
  --panel: rgba(255, 250, 244, 0.84);
  --panel-border: rgba(43, 39, 34, 0.08);
  --text: #1e1b18;
  --muted: #6d645a;
  --line: rgba(32, 28, 24, 0.12);
  --center: #1d4052;
  --thread: rgba(255, 255, 255, 0.72);
  --thread-border: rgba(22, 22, 22, 0.12);
  --shadow: 0 28px 80px rgba(38, 30, 20, 0.12);
  font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(255, 196, 121, 0.26), transparent 34%),
    radial-gradient(circle at top right, rgba(76, 148, 179, 0.22), transparent 30%),
    linear-gradient(180deg, #fbf5ec 0%, #efe6d8 100%);
}

.shell {
  width: min(1380px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 24px 0 36px;
}

.stage-card,
.panel {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 24px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
}

.stage-card {
  position: relative;
  overflow: hidden;
  padding: 26px 26px 18px;
}

.stage-copy {
  max-width: 720px;
}

.eyebrow,
.panel-label {
  margin: 0;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--muted);
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  margin-top: 10px;
  font-size: clamp(2rem, 4vw, 3.4rem);
  line-height: 0.94;
}

.subtitle {
  margin-top: 10px;
  max-width: 520px;
  font-size: 1rem;
  color: var(--muted);
}

.summary {
  margin-top: 10px;
  max-width: 720px;
  line-height: 1.55;
}

.toolbar {
  position: absolute;
  top: 24px;
  right: 24px;
  display: flex;
  gap: 10px;
}

.toolbar-button,
.thread-action,
.thread-link {
  border: 1px solid rgba(24, 24, 24, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.78);
  color: var(--text);
  font: inherit;
  text-decoration: none;
}

.toolbar-button {
  padding: 10px 14px;
  cursor: pointer;
}

.graph-stage {
  position: relative;
  min-height: 680px;
  margin-top: 18px;
  border-radius: 20px;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.36), rgba(255, 255, 255, 0.08)),
    linear-gradient(90deg, rgba(25, 20, 14, 0.06) 1px, transparent 1px),
    linear-gradient(rgba(25, 20, 14, 0.06) 1px, transparent 1px);
  background-size: auto, 36px 36px, 36px 36px;
}

.graph-stage::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at center, transparent 0 20%, rgba(255, 255, 255, 0.34) 78%, rgba(255, 255, 255, 0.72) 100%);
}

.graph-link {
  position: absolute;
  height: 1px;
  transform-origin: left center;
  background: rgba(31, 26, 21, 0.14);
  pointer-events: none;
}

.graph-link.thread-link-line {
  background: rgba(31, 26, 21, 0.08);
}

.node {
  position: absolute;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
  transition: transform 180ms ease, opacity 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
}

.node:focus-visible {
  outline: 2px solid #111;
  outline-offset: 3px;
}

.node-center {
  width: 160px;
  height: 160px;
  background: radial-gradient(circle at 30% 25%, rgba(255, 255, 255, 0.18), transparent 45%), var(--center);
  color: #fcf8f3;
  box-shadow: 0 18px 44px rgba(29, 64, 82, 0.28);
  text-align: center;
  padding: 20px;
}

.node-center strong {
  display: block;
  font-size: 1.15rem;
  line-height: 1.05;
}

.node-center span {
  margin-top: 10px;
  display: block;
  font-size: 0.78rem;
  line-height: 1.4;
  opacity: 0.82;
}

.node-obsession {
  width: 118px;
  height: 118px;
  padding: 14px;
  text-align: center;
  background: radial-gradient(circle at top, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.6));
  border: 1px solid rgba(20, 20, 20, 0.12);
  box-shadow: 0 12px 28px rgba(26, 22, 18, 0.12);
}

.node-obsession .glyph {
  display: block;
  font-size: 1.45rem;
  font-weight: 700;
  line-height: 1;
}

.node-obsession .label {
  display: block;
  margin-top: 10px;
  font-size: 0.82rem;
  line-height: 1.2;
}

.node-thread {
  width: 46px;
  height: 46px;
  background: var(--thread);
  border: 1px solid var(--thread-border);
  box-shadow: 0 10px 24px rgba(26, 22, 18, 0.08);
  color: #312821;
  font-size: 1rem;
  font-weight: 700;
  opacity: 0.38;
}

.node-thread.is-related,
.node-thread.is-selected,
.node-thread:hover,
.node-thread:focus-visible {
  opacity: 0.96;
}

.node.is-selected,
.node:hover {
  transform: translate3d(var(--x, 0px), var(--y, 0px), 0) scale(1.05);
}

.panel-grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 18px;
}

.panel {
  padding: 22px;
}

.detail-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-meta,
.detail-body,
.panel-meta {
  color: var(--muted);
  line-height: 1.5;
}

.thread-panel {
  display: grid;
  gap: 16px;
}

.panel-header,
.thread-viewer-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}

.thread-list {
  display: grid;
  gap: 12px;
}

.thread-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(30, 24, 20, 0.08);
}

.thread-item.is-active {
  border-color: rgba(18, 18, 18, 0.22);
  background: rgba(255, 255, 255, 0.92);
}

.thread-title {
  font-weight: 600;
}

.thread-meta {
  margin-top: 6px;
  font-size: 0.92rem;
  color: var(--muted);
}

.thread-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: end;
}

.thread-action,
.thread-link {
  padding: 8px 12px;
  cursor: pointer;
}

.thread-viewer {
  border-radius: 18px;
  background: rgba(26, 24, 22, 0.9);
  color: #f8f3ea;
  padding: 18px;
}

.thread-raw-text {
  margin-top: 12px;
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, "SFMono-Regular", Menlo, Monaco, monospace;
  font-size: 0.92rem;
  line-height: 1.55;
}

.thread-empty {
  padding: 16px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.55);
  color: var(--muted);
}

@media (max-width: 1080px) {
  .panel-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .shell {
    width: min(100vw - 18px, 100%);
    padding-top: 10px;
  }

  .stage-card,
  .panel {
    border-radius: 20px;
  }

  .toolbar {
    position: static;
    margin-top: 18px;
  }

  .graph-stage {
    min-height: 540px;
  }

  .node-center {
    width: 132px;
    height: 132px;
  }

  .node-obsession {
    width: 98px;
    height: 98px;
  }
}
`;
}

function buildJsTemplate() {
  return `const DATA_PATH = "./core-obsessions-graph.data.json";
const INLINE_DATA_ID = "core-obsessions-graph-data";

const stage = document.getElementById("graph-stage");
const profileTitle = document.getElementById("profile-title");
const profileSubtitle = document.getElementById("profile-subtitle");
const profileSummary = document.getElementById("profile-summary");
const detailTitle = document.getElementById("detail-title");
const detailMeta = document.getElementById("detail-meta");
const detailBody = document.getElementById("detail-body");
const threadPanelTitle = document.getElementById("thread-panel-title");
const threadPanelMeta = document.getElementById("thread-panel-meta");
const threadList = document.getElementById("thread-list");
const threadViewerTitle = document.getElementById("thread-viewer-title");
const threadViewerMeta = document.getElementById("thread-viewer-meta");
const threadRawText = document.getElementById("thread-raw-text");
const driftToggle = document.getElementById("drift-toggle");
const resetButton = document.getElementById("reset-button");

const state = {
  data: null,
  selectedId: null,
  selectedKind: "profile",
  driftEnabled: true,
  nodeElements: new Map(),
  positions: new Map(),
  activeThreadId: null
};

const shardManifestCache = new Map();
const shardIndexCache = new Map();
const shardLiteralStoreCache = new Map();
const shardLexiconCache = new Map();
const shardTemplateCache = new Map();
const recordTextCache = new Map();

main().catch((error) => {
  console.error(error);
  detailTitle.textContent = "Graph unavailable";
  detailMeta.textContent = error.message || "Unable to load artifact data.";
});

async function main() {
  state.data = await loadGraphData();
  hydrateProfile();
  renderGraph();
  bindEvents();
  selectProfile();
}

async function loadGraphData() {
  const inline = document.getElementById(INLINE_DATA_ID);
  if (inline?.textContent) {
    return JSON.parse(inline.textContent);
  }

  const response = await fetch(DATA_PATH);
  if (!response.ok) {
    throw new Error("Could not load graph data.");
  }

  return response.json();
}

function hydrateProfile() {
  const profile = state.data.profile || {};
  profileTitle.textContent = profile.title || "Core obsessions";
  profileSubtitle.textContent = profile.subtitle || "";
  profileSummary.textContent = profile.summary || "";
}

function bindEvents() {
  driftToggle.addEventListener("click", () => {
    state.driftEnabled = !state.driftEnabled;
    driftToggle.textContent = state.driftEnabled ? "Drift on" : "Drift off";
    driftToggle.setAttribute("aria-pressed", String(state.driftEnabled));
    updateNodePositions();
  });

  resetButton.addEventListener("click", () => {
    selectProfile();
  });

  window.addEventListener("resize", () => {
    renderGraph();
    refreshSelection();
  });
}

function renderGraph() {
  stage.innerHTML = "";
  state.nodeElements.clear();
  state.positions.clear();

  const width = Math.max(stage.clientWidth, 320);
  const height = Math.max(stage.clientHeight, 420);
  const center = { x: width / 2, y: height / 2 };
  const obsessionRadius = Math.min(width, height) * 0.31;
  const threadRadius = Math.min(width, height) * 0.43;

  const centerNode = createNode({
    id: "profile",
    kind: "profile",
    x: center.x,
    y: center.y,
    size: 160
  });
  centerNode.className = "node node-center";
  centerNode.innerHTML = "<div><strong>Archive self</strong><span>Top recurring themes linked directly to retrieval shards.</span></div>";
  stage.appendChild(centerNode);
  state.nodeElements.set("profile", centerNode);
  state.positions.set("profile", { driftX: 0, driftY: 0 });

  const obsessions = state.data.obsessions || [];
  const graphThreadSet = new Set(state.data.graph_thread_ids || []);
  const threadMap = new Map((state.data.threads || []).map((thread) => [thread.id, thread]));

  obsessions.forEach((obsession, index) => {
    const angle = ((Math.PI * 2) / Math.max(1, obsessions.length)) * index - Math.PI / 2;
    const x = center.x + Math.cos(angle) * obsessionRadius;
    const y = center.y + Math.sin(angle) * obsessionRadius;

    const node = createNode({
      id: obsession.id,
      kind: "obsession",
      x,
      y,
      size: 118
    });
    node.className = "node node-obsession";
    node.style.borderColor = obsession.accent;
    node.innerHTML = \`<div><span class="glyph">\${escapeHtml(obsession.glyph)}</span><span class="label">\${escapeHtml(obsession.label)}</span></div>\`;
    stage.appendChild(createLink(center.x, center.y, x, y, ""));
    stage.appendChild(node);
    state.nodeElements.set(obsession.id, node);
    state.positions.set(obsession.id, {
      driftX: Math.cos(angle * 1.4) * 8,
      driftY: Math.sin(angle * 1.7) * 8
    });

    const threadIds = (obsession.thread_ids || []).filter((id) => graphThreadSet.has(id));
    threadIds.forEach((threadId, threadIndex) => {
      const thread = threadMap.get(threadId);
      if (!thread) {
        return;
      }

      const threadAngle = angle + (threadIndex - (threadIds.length - 1) / 2) * 0.28;
      const tx = center.x + Math.cos(threadAngle) * threadRadius;
      const ty = center.y + Math.sin(threadAngle) * threadRadius;

      const threadNode = createNode({
        id: thread.id,
        kind: "thread",
        x: tx,
        y: ty,
        size: 46
      });
      threadNode.className = "node node-thread";
      threadNode.textContent = thread.marker || "o";
      stage.appendChild(createLink(x, y, tx, ty, "thread-link-line"));
      stage.appendChild(threadNode);
      state.nodeElements.set(thread.id, threadNode);
      state.positions.set(thread.id, {
        driftX: Math.cos(threadAngle * 2.2) * 10,
        driftY: Math.sin(threadAngle * 1.9) * 10
      });
    });
  });

  updateNodePositions();
}

function createNode({ id, kind, x, y, size }) {
  const node = document.createElement("button");
  node.type = "button";
  node.dataset.id = id;
  node.dataset.kind = kind;
  node.style.width = size + "px";
  node.style.height = size + "px";
  node.style.left = x - size / 2 + "px";
  node.style.top = y - size / 2 + "px";
  node.addEventListener("click", () => selectNode(id, kind));
  return node;
}

function createLink(x1, y1, x2, y2, className) {
  const line = document.createElement("div");
  line.className = className ? "graph-link " + className : "graph-link";
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  line.style.width = length + "px";
  line.style.left = x1 + "px";
  line.style.top = y1 + "px";
  line.style.transform = "rotate(" + angle + "deg)";
  return line;
}

function updateNodePositions() {
  state.positions.forEach((position, id) => {
    const node = state.nodeElements.get(id);
    if (!node) {
      return;
    }

    const driftX = state.driftEnabled ? position.driftX : 0;
    const driftY = state.driftEnabled ? position.driftY : 0;
    node.style.setProperty("--x", driftX + "px");
    node.style.setProperty("--y", driftY + "px");
    node.style.transform = "translate3d(" + driftX + "px, " + driftY + "px, 0)";
  });
}

function selectProfile() {
  state.selectedId = "profile";
  state.selectedKind = "profile";
  state.activeThreadId = null;
  updateSelectionClasses();

  const stats = state.data.stats || {};
  detailTitle.textContent = state.data.profile?.title || "Core obsessions";
  detailMeta.textContent = state.data.profile?.subtitle || "";
  detailBody.textContent = "This root artifact is generated directly from the archive. Pick an obsession node to inspect the sessions that most strongly support it, then reconstruct the session from symbolic and textpack shards.";

  threadPanelTitle.textContent = "Archive evidence";
  threadPanelMeta.textContent = stats.threaded_evidence_count
    ? stats.threaded_evidence_count + " linked evidence threads are available."
    : "No thread evidence is available.";

  renderThreadList(state.data.threads || [], "All linked threads");
  resetThreadViewer();
}

function selectNode(id, kind) {
  state.selectedId = id;
  state.selectedKind = kind;

  if (kind === "obsession") {
    renderObsession(id);
    return;
  }

  if (kind === "thread") {
    renderThreadNode(id);
    return;
  }

  selectProfile();
}

function refreshSelection() {
  if (state.selectedKind === "obsession") {
    renderObsession(state.selectedId);
    return;
  }

  if (state.selectedKind === "thread") {
    renderThreadNode(state.selectedId);
    return;
  }

  selectProfile();
}

function renderObsession(id) {
  const obsession = (state.data.obsessions || []).find((item) => item.id === id);
  if (!obsession) {
    selectProfile();
    return;
  }

  state.selectedId = obsession.id;
  state.selectedKind = "obsession";
  state.activeThreadId = null;
  updateSelectionClasses();

  detailTitle.textContent = obsession.label;
  detailMeta.textContent = "importance " + obsession.importance.toFixed(2) + " | " +
    obsession.session_count + " sessions | " +
    obsession.recurrence_count + " recurrence score";
  detailBody.textContent = "This concept persisted across multiple sessions strongly enough to survive filtering and clustering. The linked threads below point to concrete symbolic shards for direct inspection.";

  const threads = getThreadsForObsession(obsession.id);
  threadPanelTitle.textContent = obsession.label + " evidence";
  threadPanelMeta.textContent = threads.length
    ? threads.length + " linked sessions"
    : "No linked sessions for this obsession.";
  renderThreadList(threads, obsession.label + " evidence");
}

function renderThreadNode(id) {
  const thread = (state.data.threads || []).find((item) => item.id === id);
  if (!thread) {
    selectProfile();
    return;
  }

  state.selectedId = thread.id;
  state.selectedKind = "thread";
  state.activeThreadId = thread.id;
  updateSelectionClasses();

  detailTitle.textContent = thread.title;
  detailMeta.textContent = thread.session_id + " | " + thread.chunk_count + " chunks | " + thread.turn_count + " turns";
  detailBody.textContent = "This thread is one of the strongest archive anchors for " + thread.concept_label + ". Reconstruct it from the symbolic stream to inspect the raw conversation text.";

  const obsessionThreads = getThreadsForObsession(thread.concept_id);
  threadPanelTitle.textContent = thread.concept_label + " evidence";
  threadPanelMeta.textContent = "Selected thread: " + thread.session_id;
  renderThreadList(obsessionThreads, thread.concept_label + " evidence");
}

function getThreadsForObsession(conceptId) {
  return (state.data.threads || []).filter((thread) => thread.concept_id === conceptId);
}

function updateSelectionClasses() {
  const selectedThread = state.selectedKind === "thread"
    ? (state.data.threads || []).find((thread) => thread.id === state.selectedId)
    : null;

  state.nodeElements.forEach((node, id) => {
    node.classList.toggle("is-selected", id === state.selectedId);
    if (node.dataset.kind === "thread") {
      let related = state.selectedKind === "profile";
      if (state.selectedKind === "obsession") {
        related = getThreadsForObsession(state.selectedId).some((thread) => thread.id === id);
      } else if (selectedThread) {
        const candidate = (state.data.threads || []).find((thread) => thread.id === id);
        related = candidate ? candidate.concept_id === selectedThread.concept_id : false;
      }
      node.classList.toggle("is-related", related);
    }
  });
}

function renderThreadList(threads, emptyLabel) {
  threadList.innerHTML = "";

  if (!threads.length) {
    const empty = document.createElement("div");
    empty.className = "thread-empty";
    empty.textContent = "No threads available for " + emptyLabel + ".";
    threadList.appendChild(empty);
    return;
  }

  threads.forEach((thread) => {
    const item = document.createElement("article");
    item.className = "thread-item";
    if (thread.id === state.activeThreadId) {
      item.classList.add("is-active");
    }

    const copy = document.createElement("div");
    const title = document.createElement("div");
    title.className = "thread-title";
    title.textContent = thread.title;

    const meta = document.createElement("div");
    meta.className = "thread-meta";
    meta.textContent = thread.session_id + " | " + thread.chunk_count + " chunks | " + thread.turn_count + " turns";

    copy.appendChild(title);
    copy.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "thread-actions";

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "thread-action";
    focusButton.textContent = "Focus";
    focusButton.addEventListener("click", () => renderThreadNode(thread.id));

    const reconstructButton = document.createElement("button");
    reconstructButton.type = "button";
    reconstructButton.className = "thread-action";
    reconstructButton.textContent = "Reconstruct raw text";
    reconstructButton.addEventListener("click", () => reconstructThread(thread));

    actions.appendChild(focusButton);
    actions.appendChild(reconstructButton);

    if (thread.symbolic_path) {
      const shardLink = document.createElement("a");
      shardLink.className = "thread-link";
      shardLink.href = "./" + thread.symbolic_path;
      shardLink.target = "_blank";
      shardLink.rel = "noreferrer";
      shardLink.textContent = "Open symbolic shard";
      actions.appendChild(shardLink);
    }

    item.appendChild(copy);
    item.appendChild(actions);
    threadList.appendChild(item);
  });
}

function resetThreadViewer() {
  threadViewerTitle.textContent = "Raw text reconstruction";
  threadViewerMeta.textContent = "Select a thread and reconstruct it from symbolic plus textpack shards.";
  threadRawText.textContent = "No thread reconstructed yet.";
}

async function reconstructThread(thread) {
  state.activeThreadId = thread.id;
  updateSelectionClasses();

  renderThreadList(
    state.selectedKind === "obsession" ? getThreadsForObsession(state.selectedId) :
      state.selectedKind === "thread" ? getThreadsForObsession(thread.concept_id) :
        (state.data.threads || []),
    "archive evidence"
  );

  threadViewerTitle.textContent = thread.title;
  threadViewerMeta.textContent = "Reconstructing " + thread.session_id + "...";
  threadRawText.textContent = "Loading symbolic rows and resolving textpack references...";

  if (thread.raw_text) {
    threadViewerMeta.textContent = thread.session_id + " | packaged reconstruction";
    threadRawText.textContent = thread.raw_text;
    return;
  }

  if (!thread.symbolic_path) {
    threadViewerMeta.textContent = "Symbolic stream unavailable";
    threadRawText.textContent = "This ZIP was generated without symbolic streams, so raw-text reconstruction is unavailable in this viewer.";
    return;
  }

  try {
    const records = await reconstructSession(thread.session_id);
    threadViewerMeta.textContent = thread.session_id + " | " + records.length + " symbolic rows";
    threadRawText.textContent = records.join("\\n\\n");
  } catch (error) {
    threadViewerMeta.textContent = "Reconstruction failed";
    threadRawText.textContent = error.message || "Unable to reconstruct thread text.";
  }
}

async function reconstructSession(sessionId) {
  const response = await fetch("./local_memory/symbolic/" + sessionId + ".stream.jsonl");
  if (!response.ok) {
    throw new Error("Could not open symbolic stream for " + sessionId + ".");
  }

  const source = await response.text();
  const rows = source
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const output = [];
  for (const row of rows) {
    const prefix = row.speaker_role ? row.speaker_role.toUpperCase() + ": " : "";
    const text = row.textpack_ref ? await reconstructRecord(row.textpack_ref) : "[missing textpack ref]";
    output.push(prefix + text);
  }

  return output;
}

async function reconstructRecord(textpackRef) {
  const shardPath = String(textpackRef.shard || "");
  const shardNumber = extractShardNumber(shardPath);
  const recordNumber = Number(textpackRef.record);
  const cacheKey = shardNumber + ":" + recordNumber;
  if (recordTextCache.has(cacheKey)) {
    return recordTextCache.get(cacheKey);
  }

  const [indexRows, literalStore, lexiconById, templateById] = await Promise.all([
    loadShardIndex(shardPath, shardNumber),
    loadShardLiteralStore(shardPath),
    loadShardLexicon(shardNumber),
    loadShardTemplates(shardNumber)
  ]);

  const row = indexRows.find((entry) => Number(entry.record) === recordNumber);
  if (!row) {
    throw new Error("Missing textpack record " + recordNumber + " in shard " + shardNumber + ".");
  }

  let text = "";
  if (Number.isFinite(row.base_record)) {
    const baseText = await reconstructRecord({ shard: shardPath, record: row.base_record });
    text = applyPatchOps(baseText, row.patch_ops || [], literalStore);
  } else {
    const inner = Array.isArray(row.segments)
      ? row.segments.map((segment) => readSegment(segment, literalStore, lexiconById)).join("")
      : "";
    const template = Number.isFinite(row.template_id) ? templateById.get(Number(row.template_id)) : null;
    text = template
      ? String(template.prefix || "") + inner + String(template.suffix || "")
      : inner;
  }

  recordTextCache.set(cacheKey, text);
  return text;
}

async function loadShardIndex(shardPath, shardNumber) {
  if (!shardIndexCache.has(shardNumber)) {
    const promise = fetch(toFetchPath(shardPath.replace(/\\.bin$/, ".index.jsonl")))
      .then((response) => {
        if (!response.ok) {
          throw new Error("Missing textpack index shard " + shardNumber + ".");
        }
        return response.text();
      })
      .then((source) => source
        .split(/\\r?\\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line)));
    shardIndexCache.set(shardNumber, promise);
  }

  return shardIndexCache.get(shardNumber);
}

async function loadShardLiteralStore(shardPath) {
  const shardNumber = extractShardNumber(shardPath);
  if (!shardLiteralStoreCache.has(shardNumber)) {
    const promise = fetch(toFetchPath(shardPath))
      .then((response) => {
        if (!response.ok) {
          throw new Error("Missing textpack binary shard " + shardNumber + ".");
        }
        return response.text();
      })
      .then((source) => String(source || ""));
    shardLiteralStoreCache.set(shardNumber, promise);
  }

  return shardLiteralStoreCache.get(shardNumber);
}

async function loadShardManifest(shardNumber) {
  if (!shardManifestCache.has(shardNumber)) {
    const promise = fetchJsonIfExists("./local_memory/textpack/textpack_manifest.json")
      .then((manifest) => {
        if (manifest?.dictionary?.lexicon_path && manifest?.dictionary?.templates_path) {
          return manifest;
        }

        return fetchJsonIfExists("./local_memory/textpack/textpack_manifest_" + shardNumber + ".json");
      })
      .then((manifest) => {
        if (!manifest) {
          throw new Error("Missing textpack manifest for shard " + shardNumber + ".");
        }

        return manifest;
      });
    shardManifestCache.set(shardNumber, promise);
  }

  return shardManifestCache.get(shardNumber);
}

async function loadShardLexicon(shardNumber) {
  if (!shardLexiconCache.has(shardNumber)) {
    const promise = loadShardManifest(shardNumber)
      .then((manifest) => fetchJsonByArchivePath(manifest?.dictionary?.lexicon_path, "Missing lexicon shard " + shardNumber + "."))
      .then((payload) => new Map(
        ((Array.isArray(payload?.entries) ? payload.entries : [])).map((entry) => [entry.phrase_id, entry.text])
      ));
    shardLexiconCache.set(shardNumber, promise);
  }

  return shardLexiconCache.get(shardNumber);
}

async function loadShardTemplates(shardNumber) {
  if (!shardTemplateCache.has(shardNumber)) {
    const promise = loadShardManifest(shardNumber)
      .then((manifest) => fetchJsonByArchivePath(manifest?.dictionary?.templates_path, "Missing template shard " + shardNumber + "."))
      .then((payload) => new Map(
        ((Array.isArray(payload?.entries) ? payload.entries : [])).map((entry) => [Number(entry.template_id), entry])
      ));
    shardTemplateCache.set(shardNumber, promise);
  }

  return shardTemplateCache.get(shardNumber);
}

async function fetchJsonByArchivePath(path, errorMessage) {
  if (!path) {
    throw new Error(errorMessage);
  }

  const response = await fetch(toFetchPath(path));
  if (!response.ok) {
    throw new Error(errorMessage);
  }

  return response.json();
}

async function fetchJsonIfExists(path) {
  const response = await fetch(path);
  if (!response.ok) {
    return null;
  }

  return response.json();
}

function toFetchPath(path) {
  const normalized = String(path || "").replace(/^\\.\\//, "");
  return "./" + normalized.replace(/^\\//, "");
}

function readSegment(segment, literalStore, lexiconById) {
  if (segment.type === "phrase") {
    return lexiconById.get(segment.phrase_id) || "";
  }

  if (!segment.literal_ref) {
    return "";
  }

  return readLiteral(literalStore, segment.literal_ref.offset, segment.literal_ref.length);
}

function readLiteral(literalStore, offset, length) {
  return String(literalStore || "").slice(offset, offset + length);
}

function applyPatchOps(baseText, patchOps, literalStore) {
  let current = String(baseText || "");

  for (const operation of patchOps) {
    if (operation.op !== "replace_range") {
      continue;
    }

    const insertText = operation.insert_ref
      ? readLiteral(literalStore, operation.insert_ref.offset, operation.insert_ref.length)
      : "";

    const start = Math.max(0, Math.min(current.length, operation.start || 0));
    const deleteCount = Math.max(0, operation.delete_count || 0);
    current = current.slice(0, start) + insertText + current.slice(start + deleteCount);
  }

  return current;
}

function extractShardNumber(path) {
  const match = String(path || "").match(/textpack_(\\d+)\\.bin$/);
  if (!match) {
    throw new Error("Unsupported textpack shard path: " + path);
  }

  return match[1];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
`;
}

export function buildCoreObsessionsArtifactDebugId(input) {
  return stableHash(JSON.stringify(input || {}));
}

function buildSessionRawTextMap(chunks) {
  const chunksBySessionId = new Map();

  for (const chunk of chunks) {
    if (!chunk?.session_id || typeof chunk.text !== "string") {
      continue;
    }

    if (!chunksBySessionId.has(chunk.session_id)) {
      chunksBySessionId.set(chunk.session_id, []);
    }

    chunksBySessionId.get(chunk.session_id).push(chunk);
  }

  const sessionRawTextById = new Map();
  for (const [sessionId, sessionChunks] of chunksBySessionId.entries()) {
    sessionChunks.sort((left, right) => (left.seq_in_session || 0) - (right.seq_in_session || 0));
    const text = sessionChunks
      .map((chunk) => {
        const prefix = chunk.speaker_role && chunk.speaker_role !== "unknown"
          ? `${String(chunk.speaker_role).toUpperCase()}: `
          : "";
        return prefix + String(chunk.text || "");
      })
      .filter(Boolean)
      .join("\n\n");

    if (text) {
      sessionRawTextById.set(sessionId, text);
    }
  }

  return sessionRawTextById;
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
