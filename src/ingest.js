import { normalizeWhitespace } from "./utils.js";

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "th", "thead", "tr", "ul"
]);

const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "template"]);
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

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
      flattenJson(parsed, "$", lines, 0, limits);

      if (limits.truncated) {
        pushWarning("JSON normalization truncated very deep or very large structures.");
      }

      if (!lines.length) {
        return "";
      }

      return normalizeLineStructure(lines.join("\n"));
    } catch {
      // Fall through to tolerant parsing for partial or malformed JSON.
    }
  }

  flattenJsonFragment(trimmed, lines, limits);

  if (limits.truncated) {
    pushWarning("JSON normalization truncated very deep or very large structures.");
  }

  if (!lines.length) {
    pushWarning("JSON normalization could not extract structured values. Falling back to raw text processing.");
    return normalizeLineStructure(source);
  }

  return normalizeLineStructure(lines.join("\n"));
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

