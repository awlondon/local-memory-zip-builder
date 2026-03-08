import { normalizeWhitespace } from "./utils.js";

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "th", "thead", "tr", "ul"
]);

const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "template"]);
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_RETRIEVAL_NOISE_PATH = /(?:^|\.)(?:id|parent|children(?:\[\d+\])?|create_time|update_time|status|weight|recipient|model_slug|default_model_slug|safe_urls|citations|metadata(?:\.|$)|finish_details|audio_transcription|jit_[^.]+|canvas|invoked_plugin|dalle|is_visually_hidden|message_type|request_id|conversation_id)(?:$|\.)/i;
const JSON_RETRIEVAL_KEEP_PATH = /(?:^|\.)(?:title|conversation_title|author\.role|author\.name|speaker_role|role|content\.parts\[\d+\]|content\.text|content\.result|content|text|summary|body|prompt|response|description|instructions)(?:$|\.)/i;

export function detectInputFormat(fileName, mimeType) {
  const name = (fileName || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();

  if (name.endsWith(".json") || mime.includes("json")) {
    return "json";
  }

  if (name.endsWith(".html") || name.endsWith(".htm") || mime.includes("html")) {
    return "html";
  }

  return "text";
}

export function normalizeInputForRetrieval(rawText, inputFormat, pushWarning = () => {}) {
  if (inputFormat === "json") {
    return normalizeJsonInput(rawText, pushWarning);
  }

  if (inputFormat === "html") {
    return normalizeHtmlInput(rawText);
  }

  return normalizePlainTextInput(rawText);
}

export function rawInputShardPath(fileName, inputFormat) {
  const base = "local_memory/raw/input_full";

  if (inputFormat === "json") {
    return `${base}.json`;
  }

  if (inputFormat === "html") {
    return `${base}.html`;
  }

  const lower = (fileName || "").toLowerCase();
  if (lower.endsWith(".md")) {
    return `${base}.md`;
  }
  if (lower.endsWith(".log")) {
    return `${base}.log`;
  }

  return `${base}.txt`;
}

function normalizePlainTextInput(rawText) {
  return normalizeLineStructure(rawText || "");
}

function normalizeHtmlInput(rawText) {
  const source = String(rawText || "");
  const out = [];

  let i = 0;
  let skipContentTag = null;

  while (i < source.length) {
    const ch = source[i];

    if (ch !== "<") {
      if (!skipContentTag) {
        out.push(ch);
      }
      i += 1;
      continue;
    }

    if (source.startsWith("<!--", i)) {
      const endComment = source.indexOf("-->", i + 4);
      i = endComment >= 0 ? endComment + 3 : source.length;
      if (!skipContentTag) {
        out.push(" ");
      }
      continue;
    }

    const endTag = source.indexOf(">", i + 1);
    if (endTag < 0) {
      if (!skipContentTag) {
        out.push(" ");
      }
      break;
    }

    const insideRaw = source.slice(i + 1, endTag);
    const inside = insideRaw.trim().toLowerCase();

    if (inside.startsWith("!doctype") || inside.startsWith("?xml")) {
      i = endTag + 1;
      continue;
    }

    let tagBody = inside;
    let isClosing = false;
    if (tagBody.startsWith("/")) {
      isClosing = true;
      tagBody = tagBody.slice(1).trim();
    }

    const tagNameMatch = tagBody.match(/^([a-z0-9:-]+)/);
    const tagName = tagNameMatch ? tagNameMatch[1] : "";

    if (skipContentTag) {
      if (isClosing && tagName === skipContentTag) {
        skipContentTag = null;
        if (BLOCK_TAGS.has(tagName)) {
          out.push("\n");
        }
      }
      i = endTag + 1;
      continue;
    }

    if (!isClosing && tagName && SKIP_CONTENT_TAGS.has(tagName)) {
      skipContentTag = tagName;
      i = endTag + 1;
      continue;
    }

    if (tagName && BLOCK_TAGS.has(tagName)) {
      out.push("\n");
    } else {
      out.push(" ");
    }

    i = endTag + 1;
  }

  const text = decodeHtmlEntities(out.join(""));
  return normalizeLineStructure(text);
}

function normalizeJsonInput(rawText, pushWarning) {
  const source = String(rawText || "");
  const trimmed = source.trim();

  if (!trimmed) {
    return "";
  }

  const lines = [];
  const limits = {
    maxLines: 250000,
    maxDepth: 40,
    maxValueLength: 800,
    maxPathSegmentLength: 120,
    truncated: false
  };

  // Fast path for complete JSON documents; low-memory part slices often use tolerant mode below.
  if (looksLikeCompleteJsonDocument(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      const structuredConversationText = serializeStructuredConversationJson(parsed);
      if (structuredConversationText) {
        return normalizeLineStructure(structuredConversationText);
      }

      flattenJson(parsed, "$", lines, 0, limits);
      const renderedConversationLines = renderConversationPathLines(lines);
      if (renderedConversationLines) {
        return normalizeLineStructure(renderedConversationLines);
      }

      const filteredLines = filterJsonLinesForRetrieval(lines);

      if (limits.truncated) {
        pushWarning("JSON normalization truncated very deep or very large structures.");
      }

      if (!filteredLines.length) {
        return "";
      }

      return normalizeLineStructure(filteredLines.join("\n"));
    } catch {
      // Fall through to tolerant parsing for partial or malformed JSON.
    }
  }

  flattenJsonFragment(trimmed, lines, limits);
  const renderedConversationLines = renderConversationPathLines(lines);
  if (renderedConversationLines) {
    return normalizeLineStructure(renderedConversationLines);
  }

  const filteredLines = filterJsonLinesForRetrieval(lines);

  if (limits.truncated) {
    pushWarning("JSON normalization truncated very deep or very large structures.");
  }

  if (!filteredLines.length) {
    pushWarning("JSON normalization could not extract structured values. Falling back to raw text processing.");
    return normalizeLineStructure(source);
  }

  return normalizeLineStructure(filteredLines.join("\n"));
}

function serializeStructuredConversationJson(value) {
  const conversations = extractConversationCandidates(value);
  if (!conversations.length) {
    return "";
  }

  const rendered = [];
  for (let index = 0; index < conversations.length; index += 1) {
    const transcript = renderStructuredConversation(conversations[index], index + 1);
    if (!transcript) {
      continue;
    }

    if (rendered.length) {
      rendered.push("");
    }
    rendered.push(transcript);
  }

  return rendered.join("\n");
}

function extractConversationCandidates(value) {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    const structuredItems = value.filter((item) => isConversationLikeObject(item));
    if (structuredItems.length) {
      return structuredItems;
    }

    if (value.some((item) => isMessageLikeObject(item))) {
      return [{ title: "Conversation 1", messages: value }];
    }

    return [];
  }

  if (Array.isArray(value.conversations)) {
    return value.conversations.filter((item) => isConversationLikeObject(item));
  }

  if (Array.isArray(value.messages)) {
    return [value];
  }

  return isConversationLikeObject(value) ? [value] : [];
}

function isConversationLikeObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (
      (value.mapping && typeof value.mapping === "object") ||
      Array.isArray(value.messages)
    )
  );
}

function isMessageLikeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  if (value.author?.role || value.role || value.speaker_role) {
    return true;
  }

  if (value.message && typeof value.message === "object") {
    return isMessageLikeObject(value.message);
  }

  return value.content !== undefined || value.text !== undefined;
}

function renderStructuredConversation(conversation, ordinal) {
  const title = normalizeWhitespace(
    conversation.title ||
    conversation.conversation_title ||
    conversation.name ||
    conversation.topic ||
    `Conversation ${ordinal}`
  );
  const messages = extractStructuredConversationMessages(conversation);

  if (!messages.length) {
    return "";
  }

  const lines = [`# Conversation: ${title}`];

  for (const message of messages) {
    const renderedLines = renderTranscriptMessage(message);
    if (!renderedLines.length) {
      continue;
    }

    lines.push("");
    lines.push(...renderedLines);
  }

  return lines.join("\n").trim();
}

function extractStructuredConversationMessages(conversation) {
  if (Array.isArray(conversation.messages)) {
    return conversation.messages
      .map((entry, index) => extractStructuredMessageRecord(entry, index))
      .filter((entry) => Boolean(entry?.text))
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.create_time) ? left.create_time : Number.POSITIVE_INFINITY;
        const rightTime = Number.isFinite(right.create_time) ? right.create_time : Number.POSITIVE_INFINITY;
        return leftTime - rightTime || left.sort_index - right.sort_index;
      });
  }

  if (conversation.mapping && typeof conversation.mapping === "object") {
    const orderedKeys = orderConversationMappingKeys(conversation.mapping, conversation.current_node);
    const records = [];

    for (let index = 0; index < orderedKeys.length; index += 1) {
      const key = orderedKeys[index];
      const node = conversation.mapping[key];
      if (!node || !node.message) {
        continue;
      }

      const record = extractStructuredMessageRecord(node.message, index, node);
      if (record?.text) {
        records.push(record);
      }
    }

    return records;
  }

  return [];
}

function orderConversationMappingKeys(mapping, currentNode) {
  if (currentNode && mapping[currentNode]) {
    const chain = [];
    const seen = new Set();
    let cursor = currentNode;

    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = mapping[cursor].parent || null;
    }

    chain.reverse();
    const chainWithMessages = chain.filter((key) => mapping[key]?.message);
    if (chainWithMessages.length >= 2) {
      return chainWithMessages;
    }
  }

  const entries = Object.entries(mapping);
  const withTimes = entries.map(([key, node], index) => ({
    key,
    index,
    createTime: toNumericTime(node?.message?.create_time ?? node?.create_time ?? null)
  }));
  const timestampCount = withTimes.filter((entry) => Number.isFinite(entry.createTime)).length;

  if (timestampCount >= Math.max(2, Math.floor(entries.length * 0.4))) {
    return withTimes
      .sort((left, right) => (
        left.createTime - right.createTime ||
        left.index - right.index ||
        left.key.localeCompare(right.key)
      ))
      .map((entry) => entry.key);
  }

  const ordered = [];
  const visited = new Set();
  const roots = entries
    .filter(([, node]) => !node?.parent || !mapping[node.parent])
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));

  function visit(key) {
    if (!key || visited.has(key) || !mapping[key]) {
      return;
    }

    visited.add(key);
    ordered.push(key);

    const children = Array.isArray(mapping[key].children) ? mapping[key].children : [];
    for (const childKey of children) {
      visit(childKey);
    }
  }

  for (const root of roots) {
    visit(root);
  }

  for (const [key] of entries.sort((left, right) => left[0].localeCompare(right[0]))) {
    visit(key);
  }

  return ordered;
}

function extractStructuredMessageRecord(value, index, node = null) {
  const payload = value?.message && typeof value.message === "object" ? value.message : value;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const role = normalizeConversationRole(
    payload.author?.role ||
    payload.role ||
    payload.speaker_role ||
    node?.author?.role ||
    node?.role ||
    ""
  );
  const name = normalizeWhitespace(
    payload.author?.name ||
    payload.name ||
    node?.author?.name ||
    ""
  );
  const text = normalizeTranscriptBody(
    extractConversationContentText(
      payload.content !== undefined
        ? payload.content
        : payload.text !== undefined
          ? payload.text
          : payload.parts !== undefined
            ? { parts: payload.parts }
            : payload
    )
  );

  if (!text) {
    return null;
  }

  return {
    role,
    name,
    text,
    create_time: toNumericTime(payload.create_time ?? node?.create_time ?? null),
    sort_index: index
  };
}

function extractConversationContentText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return dedupeTextFragments(
      value
        .map((entry) => extractConversationContentText(entry, depth + 1))
        .filter(Boolean)
    ).join("\n");
  }

  if (typeof value !== "object") {
    return "";
  }

  const fragments = [];

  if (Array.isArray(value.parts)) {
    fragments.push(extractConversationContentText(value.parts, depth + 1));
  }
  if (value.text !== undefined) {
    fragments.push(extractConversationContentText(value.text, depth + 1));
  }
  if (value.result !== undefined) {
    fragments.push(extractConversationContentText(value.result, depth + 1));
  }
  if (value.content !== undefined && value.content !== value) {
    fragments.push(extractConversationContentText(value.content, depth + 1));
  }
  if (value.output_text !== undefined) {
    fragments.push(extractConversationContentText(value.output_text, depth + 1));
  }
  if (value.summary !== undefined) {
    fragments.push(extractConversationContentText(value.summary, depth + 1));
  }
  if (value.message !== undefined && value.message !== value) {
    fragments.push(extractConversationContentText(value.message, depth + 1));
  }
  if (Array.isArray(value.items)) {
    fragments.push(extractConversationContentText(value.items, depth + 1));
  }
  if (value.code !== undefined) {
    fragments.push(extractConversationContentText(value.code, depth + 1));
  }

  return dedupeTextFragments(fragments.filter(Boolean)).join("\n");
}

function dedupeTextFragments(fragments) {
  const seen = new Set();
  const out = [];

  for (const fragment of fragments) {
    const normalized = normalizeWhitespace(fragment);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(fragment);
  }

  return out;
}

function normalizeConversationRole(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return "unknown";
  }

  if (/(?:^| )(user|human|person|customer|client|altair)(?: |$)/.test(normalized)) {
    return "user";
  }

  if (/(?:^| )(assistant|ai|model|ankaa|chatgpt|gpt)(?: |$)/.test(normalized) || /^gpt(?:[- ]?\d+(?:\.\d+)?)?$/.test(normalized)) {
    return "assistant";
  }

  if (/(?:^| )system(?: |$)/.test(normalized)) {
    return "system";
  }

  if (/(?:^| )(tool|browser|search|function|shell|mcp)(?: |$)/.test(normalized)) {
    return "tool";
  }

  return normalized;
}

function renderTranscriptMessage(message) {
  const text = normalizeTranscriptBody(message?.text || "");
  if (!text) {
    return [];
  }

  const label = formatTranscriptSpeakerLabel(message.role, message.name);
  const bodyLines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  if (!bodyLines.length) {
    return [];
  }

  bodyLines[0] = `${label}: ${bodyLines[0]}`;
  return bodyLines;
}

function formatTranscriptSpeakerLabel(role, name) {
  const normalizedName = normalizeWhitespace(name || "");

  switch (role) {
    case "user":
      return normalizedName && !/^user$/i.test(normalizedName) ? `User (${normalizedName})` : "User";
    case "assistant":
      return normalizedName && !/^assistant$/i.test(normalizedName) ? `Assistant (${normalizedName})` : "Assistant";
    case "system":
      return "System";
    case "tool":
      return normalizedName && !/^tool$/i.test(normalizedName) ? `Tool (${normalizedName})` : "Tool";
    default:
      return normalizedName || "Speaker";
  }
}

function normalizeTranscriptBody(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!source) {
    return "";
  }

  return source
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join("\n")
    .trim();
}

function renderConversationPathLines(lines) {
  const conversations = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseFlatJsonLine(lines[index]);
    if (!parsed) {
      continue;
    }

    const titleMatch = matchConversationTitlePath(parsed.path);
    if (titleMatch) {
      const conversation = getConversationAccumulator(conversations, titleMatch.conversationKey, index);
      if (!conversation.title && parsed.value && parsed.value !== '""') {
        conversation.title = parsed.value;
      }
      continue;
    }

    const messageMatch = matchConversationMessagePath(parsed.path);
    if (!messageMatch) {
      continue;
    }

    const conversation = getConversationAccumulator(conversations, messageMatch.conversationKey, index);
    const message = getMessageAccumulator(conversation, messageMatch.messageKey, index);

    if (messageMatch.field === "role") {
      message.role = parsed.value;
      continue;
    }

    if (messageMatch.field === "name") {
      message.name = parsed.value;
      continue;
    }

    if (messageMatch.field === "create_time") {
      message.create_time = toNumericTime(parsed.value);
      continue;
    }

    if (messageMatch.field === "content" && parsed.value && parsed.value !== '""' && parsed.value !== "null") {
      message.content.push(parsed.value);
    }
  }

  if (!conversations.size) {
    return "";
  }

  const transcripts = [];
  const orderedConversations = [...conversations.values()].sort((left, right) => left.firstSeen - right.firstSeen);

  for (let index = 0; index < orderedConversations.length; index += 1) {
    const conversation = orderedConversations[index];
    const messages = [...conversation.messages.values()]
      .map((message) => ({
        role: normalizeConversationRole(message.role),
        name: normalizeWhitespace(message.name || ""),
        text: normalizeTranscriptBody(dedupeTextFragments(message.content).join("\n")),
        create_time: message.create_time,
        sort_index: message.firstSeen
      }))
      .filter((message) => message.text)
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.create_time) ? left.create_time : Number.POSITIVE_INFINITY;
        const rightTime = Number.isFinite(right.create_time) ? right.create_time : Number.POSITIVE_INFINITY;
        return leftTime - rightTime || left.sort_index - right.sort_index;
      });

    if (messages.length < 2 || !messages.some((message) => message.role === "user" || message.role === "assistant")) {
      continue;
    }

    const rendered = renderStructuredConversation(
      {
        title: conversation.title || `Conversation ${index + 1}`,
        messages
      },
      index + 1
    );

    if (rendered) {
      transcripts.push(rendered);
    }
  }

  return transcripts.join("\n\n");
}

function filterJsonLinesForRetrieval(lines) {
  const filtered = [];

  for (const line of lines) {
    const parsed = parseFlatJsonLine(line);
    if (!parsed) {
      continue;
    }

    const compactPath = compactJsonPathForRetrieval(parsed.path);
    if (!compactPath) {
      continue;
    }

    filtered.push(`${compactPath}: ${parsed.value}`);
  }

  return filtered;
}

function parseFlatJsonLine(line) {
  if (typeof line !== "string") {
    return null;
  }

  const separatorIndex = line.indexOf(": ");
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    path: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 2).trim()
  };
}

function matchConversationTitlePath(path) {
  const normalizedPath = String(path || "");
  if (/\.message\.|\.messages\[|\.author\./.test(normalizedPath)) {
    return null;
  }

  if (normalizedPath === "title" || normalizedPath === "conversation_title") {
    return { conversationKey: "$" };
  }

  let match = normalizedPath.match(/^(?<conversationKey>.*?)(?:\.title|\.conversation_title)$/);
  if (match) {
    return {
      conversationKey: match.groups?.conversationKey || "$"
    };
  }

  match = normalizedPath.match(/^(?<conversationKey>.*?)(?:\.name)$/);
  if (match && /(?:^|\.)conversations\[\d+\]$|^\$\[\d+\]$|^[A-Za-z0-9_\-]+$/.test(match.groups?.conversationKey || "")) {
    return {
      conversationKey: match.groups?.conversationKey || "$"
    };
  }

  return null;
}

function matchConversationMessagePath(path) {
  const normalizedPath = String(path || "");
  let match = normalizedPath.match(/^(?<conversationKey>.*?)(?:\.mapping\.(?<messageKey>[^.\[\]]+)\.message)\.(?<field>.+)$/);
  if (match) {
    return normalizeConversationMessageMatch(match.groups?.conversationKey, match.groups?.messageKey, match.groups?.field);
  }

  match = normalizedPath.match(/^(?<conversationKey>.*?)(?:\.messages\[(?<messageKey>\d+)\])\.(?<field>.+)$/);
  if (match) {
    return normalizeConversationMessageMatch(match.groups?.conversationKey, `messages[${match.groups?.messageKey || "0"}]`, match.groups?.field);
  }

  return null;
}

function normalizeConversationMessageMatch(conversationKey, messageKey, field) {
  const normalizedField = String(field || "");
  let semanticField = "";

  if (normalizedField === "author.role" || normalizedField === "role" || normalizedField === "speaker_role") {
    semanticField = "role";
  } else if (normalizedField === "author.name" || normalizedField === "name") {
    semanticField = "name";
  } else if (normalizedField === "create_time") {
    semanticField = "create_time";
  } else if (
    normalizedField === "content" ||
    normalizedField === "content.text" ||
    normalizedField === "content.result" ||
    normalizedField === "text" ||
    /^content\.parts\[\d+\]$/.test(normalizedField)
  ) {
    semanticField = "content";
  } else {
    return null;
  }

  return {
    conversationKey: conversationKey || "$",
    messageKey: messageKey || "message",
    field: semanticField
  };
}

function compactJsonPathForRetrieval(path) {
  const normalizedPath = String(path || "").replace(/^\$\./, "").replace(/^\$/, "");
  if (!normalizedPath) {
    return "";
  }

  if (!JSON_RETRIEVAL_KEEP_PATH.test(normalizedPath)) {
    return "";
  }

  if (JSON_RETRIEVAL_NOISE_PATH.test(normalizedPath) && !/author\.role|author\.name|content\.parts|content\.text|content\.result|title|conversation_title$/i.test(normalizedPath)) {
    return "";
  }

  const messageMatch = matchConversationMessagePath(normalizedPath);
  if (messageMatch) {
    switch (messageMatch.field) {
      case "role":
        return "message.author.role";
      case "name":
        return "message.author.name";
      case "content":
        return "message.content";
      case "create_time":
        return "message.create_time";
      default:
        return "";
    }
  }

  if (matchConversationTitlePath(normalizedPath)) {
    return "title";
  }

  const parts = normalizedPath.split(".").filter(Boolean);
  return parts.slice(-3).join(".");
}

function getConversationAccumulator(conversations, key, firstSeen) {
  const conversationKey = key || "$";
  if (!conversations.has(conversationKey)) {
    conversations.set(conversationKey, {
      key: conversationKey,
      title: "",
      firstSeen,
      messages: new Map()
    });
  }

  return conversations.get(conversationKey);
}

function getMessageAccumulator(conversation, key, firstSeen) {
  const messageKey = key || "message";
  if (!conversation.messages.has(messageKey)) {
    conversation.messages.set(messageKey, {
      key: messageKey,
      firstSeen,
      role: "",
      name: "",
      create_time: Number.NaN,
      content: []
    });
  }

  return conversation.messages.get(messageKey);
}

function toNumericTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function flattenJson(value, path, lines, depth, limits) {
  if (lines.length >= limits.maxLines || depth > limits.maxDepth) {
    limits.truncated = true;
    return;
  }

  if (value === null) {
    lines.push(`${path}: null`);
    return;
  }

  const type = typeof value;

  if (type === "string") {
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
      lines.push(`${path}: ""`);
      return;
    }

    const out = normalized.length > limits.maxValueLength
      ? `${normalized.slice(0, limits.maxValueLength)}...`
      : normalized;

    if (normalized.length > limits.maxValueLength) {
      limits.truncated = true;
    }

    lines.push(`${path}: ${out}`);
    return;
  }

  if (type === "number" || type === "boolean") {
    lines.push(`${path}: ${String(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${path}: []`);
      return;
    }

    for (let index = 0; index < value.length; index += 1) {
      flattenJson(value[index], `${path}[${index}]`, lines, depth + 1, limits);
      if (lines.length >= limits.maxLines) {
        limits.truncated = true;
        break;
      }
    }
    return;
  }

  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  if (!keys.length) {
    lines.push(`${path}: {}`);
    return;
  }

  for (const key of keys) {
    const childPath = path === "$" ? key : `${path}.${key}`;
    flattenJson(value[key], childPath, lines, depth + 1, limits);
    if (lines.length >= limits.maxLines) {
      limits.truncated = true;
      break;
    }
  }
}

function flattenJsonFragment(source, lines, limits) {
  const stack = [];
  let rootPendingKey = null;

  let i = 0;
  while (i < source.length && lines.length < limits.maxLines) {
    const ch = source[i];

    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }

    if (ch === "{") {
      markContainerAsValue(stack);
      if (stack.length >= limits.maxDepth) {
        limits.truncated = true;
      } else {
        stack.push({ type: "object", pendingKey: null, mode: "key_or_end" });
      }
      i += 1;
      continue;
    }

    if (ch === "[") {
      markContainerAsValue(stack);
      if (stack.length >= limits.maxDepth) {
        limits.truncated = true;
      } else {
        stack.push({ type: "array", index: 0 });
      }
      i += 1;
      continue;
    }

    if (ch === "}") {
      if (stack.length && stack[stack.length - 1].type === "object") {
        stack.pop();
      }
      i += 1;
      continue;
    }

    if (ch === "]") {
      if (stack.length && stack[stack.length - 1].type === "array") {
        stack.pop();
      }
      i += 1;
      continue;
    }

    if (ch === ":") {
      const frame = stack[stack.length - 1];
      if (frame && frame.type === "object" && frame.mode === "colon") {
        frame.mode = "value";
      }
      i += 1;
      continue;
    }

    if (ch === ",") {
      const frame = stack[stack.length - 1];
      if (frame && frame.type === "object") {
        frame.mode = "key_or_end";
        frame.pendingKey = null;
      } else if (frame && frame.type === "array") {
        frame.index += 1;
      } else {
        rootPendingKey = null;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      const parsedString = readJsonStringToken(source, i, limits);
      i = parsedString.end;

      const keyCandidate = sanitizePathSegment(parsedString.value, limits);
      const frame = stack[stack.length - 1];
      const nextChar = peekNextSignificantChar(source, i);
      const shouldTreatAsKey =
        (frame && frame.type === "object" && frame.mode === "key_or_end") ||
        (!frame && nextChar === ":");

      if (shouldTreatAsKey) {
        if (frame && frame.type === "object") {
          frame.pendingKey = keyCandidate;
          frame.mode = "colon";
        } else {
          rootPendingKey = keyCandidate;
        }
        continue;
      }

      const stringValue = normalizeWhitespace(parsedString.value);
      emitFragmentValue(stringValue ? stringValue : '""', stack, rootPendingKey, lines, limits);
      consumeFragmentValue(stack, () => {
        rootPendingKey = null;
      });
      continue;
    }

    const literal = readJsonLiteralToken(source, i);
    if (literal.end <= i) {
      i += 1;
      continue;
    }

    i = literal.end;
    const normalized = normalizeLiteralValue(literal.value);
    if (!normalized) {
      continue;
    }

    emitFragmentValue(normalized, stack, rootPendingKey, lines, limits);
    consumeFragmentValue(stack, () => {
      rootPendingKey = null;
    });
  }

  if (lines.length >= limits.maxLines) {
    limits.truncated = true;
  }
}

function looksLikeCompleteJsonDocument(trimmed) {
  if (!trimmed) {
    return false;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if (first === "{") {
    return last === "}";
  }

  if (first === "[") {
    return last === "]";
  }

  if (first === '"') {
    return last === '"' && trimmed.length >= 2;
  }

  if (trimmed === "true" || trimmed === "false" || trimmed === "null") {
    return true;
  }

  return JSON_NUMBER_PATTERN.test(trimmed);
}

function readJsonStringToken(source, start, limits) {
  let i = start + 1;
  let out = "";

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      i += 1;
      return { value: out, end: i };
    }

    if (ch === "\\") {
      if (i + 1 >= source.length) {
        limits.truncated = true;
        return { value: out, end: source.length };
      }

      const esc = source[i + 1];
      let decoded = "";

      switch (esc) {
        case '"':
        case "\\":
        case "/":
          decoded = esc;
          i += 2;
          break;
        case "b":
          decoded = "\b";
          i += 2;
          break;
        case "f":
          decoded = "\f";
          i += 2;
          break;
        case "n":
          decoded = "\n";
          i += 2;
          break;
        case "r":
          decoded = "\r";
          i += 2;
          break;
        case "t":
          decoded = "\t";
          i += 2;
          break;
        case "u": {
          const hex = source.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            decoded = String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
          } else {
            decoded = "u";
            i += 2;
          }
          break;
        }
        default:
          decoded = esc;
          i += 2;
          break;
      }

      out = appendWithLimit(out, decoded, limits);
      continue;
    }

    out = appendWithLimit(out, ch, limits);
    i += 1;
  }

  limits.truncated = true;
  return { value: out, end: source.length };
}

function readJsonLiteralToken(source, start) {
  let end = start;

  while (end < source.length) {
    const ch = source[end];
    if (isWhitespace(ch) || ch === "," || ch === ":" || ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      break;
    }
    end += 1;
  }

  return {
    value: source.slice(start, end),
    end
  };
}

function appendWithLimit(base, fragment, limits) {
  if (!fragment) {
    return base;
  }

  if (base.length >= limits.maxValueLength) {
    limits.truncated = true;
    return base;
  }

  const available = limits.maxValueLength - base.length;
  if (fragment.length <= available) {
    return base + fragment;
  }

  limits.truncated = true;
  return `${base}${fragment.slice(0, available)}`;
}

function sanitizePathSegment(value, limits) {
  const normalized = normalizeWhitespace(value || "");
  if (!normalized) {
    return "(empty_key)";
  }

  if (normalized.length <= limits.maxPathSegmentLength) {
    return normalized;
  }

  limits.truncated = true;
  return `${normalized.slice(0, limits.maxPathSegmentLength)}...`;
}

function normalizeLiteralValue(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }

  if (value === "true" || value === "false" || value === "null" || JSON_NUMBER_PATTERN.test(value)) {
    return value;
  }

  return normalizeWhitespace(value);
}

function markContainerAsValue(stack) {
  const parent = stack[stack.length - 1];
  if (!parent || parent.type !== "object") {
    return;
  }

  if (parent.mode === "value") {
    parent.mode = "comma_or_end";
  }
}

function consumeFragmentValue(stack, clearRootPendingKey) {
  const frame = stack[stack.length - 1];
  if (!frame) {
    clearRootPendingKey();
    return;
  }

  if (frame.type === "object") {
    if (frame.mode === "value" || frame.mode === "colon") {
      frame.mode = "comma_or_end";
    }
    return;
  }

  if (frame.type === "array") {
    return;
  }
}

function emitFragmentValue(value, stack, rootPendingKey, lines, limits) {
  if (lines.length >= limits.maxLines) {
    limits.truncated = true;
    return;
  }

  let path = "$";

  if (rootPendingKey) {
    path = appendPathSegment(path, rootPendingKey);
  }

  for (const frame of stack) {
    if (frame.type === "object" && frame.pendingKey) {
      path = appendPathSegment(path, frame.pendingKey);
      continue;
    }

    if (frame.type === "array") {
      path = appendPathSegment(path, `[${frame.index}]`);
    }
  }

  let normalized = normalizeWhitespace(value || "");
  if (!normalized) {
    normalized = '""';
  }

  if (normalized.length > limits.maxValueLength) {
    normalized = `${normalized.slice(0, limits.maxValueLength)}...`;
    limits.truncated = true;
  }

  lines.push(`${path}: ${normalized}`);
}

function appendPathSegment(path, segment) {
  if (!segment) {
    return path;
  }

  if (/^\[\d+\]$/.test(segment)) {
    return `${path}${segment}`;
  }

  const escaped = segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const isIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment);

  if (path === "$") {
    return isIdentifier ? segment : `["${escaped}"]`;
  }

  return isIdentifier ? `${path}.${segment}` : `${path}["${escaped}"]`;
}

function peekNextSignificantChar(source, startIndex) {
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (!isWhitespace(ch)) {
      return ch;
    }
  }
  return "";
}

function isWhitespace(ch) {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    hellip: "..."
  };

  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0) {
        return String.fromCodePoint(code);
      }
      return " ";
    }

    return Object.prototype.hasOwnProperty.call(named, entity) ? named[entity] : " ";
  });
}

function normalizeLineStructure(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const compact = [];

  let current = "";
  let previousBlank = false;

  function flushCurrent() {
    const line = current.replace(/[ \t]+/g, " ").trim();
    current = "";

    if (!line) {
      if (!previousBlank) {
        compact.push("");
        previousBlank = true;
      }
      return;
    }

    compact.push(line);
    previousBlank = false;
  }

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "\n") {
      flushCurrent();
    } else {
      current += ch;
    }
  }

  flushCurrent();

  return compact.join("\n").trim();
}

