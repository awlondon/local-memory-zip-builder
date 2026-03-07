import { normalizeWhitespace } from "./utils.js";

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

  let text = source;
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|header|footer|aside|nav|h[1-6]|li|ul|ol|pre|blockquote|table|tr|td|th)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);

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
  const normalizedNewlines = String(text || "").replace(/\r\n?/g, "\n");

  const lines = normalizedNewlines
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  const compact = [];
  let previousBlank = false;

  for (const line of lines) {
    if (!line) {
      if (!previousBlank) {
        compact.push("");
        previousBlank = true;
      }
      continue;
    }

    compact.push(line);
    previousBlank = false;
  }

  return compact.join("\n").trim();
}
