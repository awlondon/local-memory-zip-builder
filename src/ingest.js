import { normalizeWhitespace } from "./utils.js";

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "th", "thead", "tr", "ul"
]);

const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "template"]);

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
  let parsed;

  try {
    parsed = JSON.parse(source);
  } catch {
    pushWarning("JSON parsing failed. Falling back to raw text processing.");
    return normalizeLineStructure(source);
  }

  const lines = [];
  const limits = {
    maxLines: 250000,
    maxDepth: 40,
    maxValueLength: 800,
    truncated: false
  };

  flattenJson(parsed, "$", lines, 0, limits);

  if (limits.truncated) {
    pushWarning("JSON normalization truncated very deep or very large structures.");
  }

  if (!lines.length) {
    return "";
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


