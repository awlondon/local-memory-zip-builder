const DETERMINISTIC_DATE = new Date(0);

export function createZipBuilder() {
  if (!window.JSZip) {
    throw new Error("JSZip is not loaded.");
  }

  const zip = new window.JSZip();

  function addFile(entry) {
    if (!entry || typeof entry.path !== "string") {
      return;
    }

    const fileOptions = {
      binary: typeof entry.content !== "string",
      createFolders: true,
      date: DETERMINISTIC_DATE,
      ...(entry.options || {})
    };

    zip.file(entry.path, entry.content, fileOptions);
  }

  async function generate(onProgress) {
    return zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      },
      (metadata) => {
        if (typeof onProgress === "function") {
          onProgress((metadata.percent || 0) / 100);
        }
      }
    );
  }

  return {
    addFile,
    generate
  };
}

export async function createZipBlob(files, onProgress) {
  const builder = createZipBuilder();
  for (const entry of files || []) {
    builder.addFile(entry);
  }
  return builder.generate(onProgress);
}

// ── Streaming zip builder (per-entry DEFLATE, no JSZip) ──────────────────────
// Processes files one-at-a-time so only one file's raw bytes are in memory at
// any given time. Each entry is individually deflated via CompressionStream then
// discarded. Final zip is assembled as a Blob from pre-built parts.

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime() {
  // Deterministic: 1980-01-01 00:00:00
  return { date: 0x0021, time: 0x0000 };
}

function encodeUTF8(str) {
  return new TextEncoder().encode(str);
}

async function toUint8Array(content) {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (content instanceof Blob) {
    return new Uint8Array(await content.arrayBuffer());
  }
  if (typeof content === "string") {
    return encodeUTF8(content);
  }
  return encodeUTF8(String(content));
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}

const HAS_COMPRESSION_STREAM = typeof CompressionStream !== "undefined";

async function deflateRaw(data) {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  const chunks = [];
  const readAll = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();

  writer.write(data);
  writer.close();
  await readAll;

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
}

export function createStreamingZipBuilder() {
  const blobParts = [];
  const centralEntries = [];
  let offset = 0;
  let fileCount = 0;
  let unflushedBytes = 0;
  const COMPACT_THRESHOLD = 32 * 1024 * 1024;

  function compactParts() {
    if (blobParts.length > 1) {
      const merged = new Blob(blobParts);
      blobParts.length = 0;
      blobParts.push(merged);
      unflushedBytes = 0;
    }
  }

  async function addFile(entry) {
    if (!entry || typeof entry.path !== "string") {
      return;
    }

    const data = await toUint8Array(entry.content);
    const fileName = encodeUTF8(entry.path);
    const crc = crc32(data);
    const uncompressedSize = data.length;
    const dt = dosDateTime();

    // Decide compression: use DEFLATE unless entry explicitly asks for STORE
    // or CompressionStream is unavailable
    const wantStore = entry.options?.compression === "STORE";
    const useDeflate = HAS_COMPRESSION_STREAM && !wantStore;
    const compressionMethod = useDeflate ? 8 : 0; // 8=DEFLATE, 0=STORE
    const compressed = useDeflate ? await deflateRaw(data) : data;
    const compressedSize = compressed.length;

    // Local file header (30 bytes + filename)
    const localHeader = new ArrayBuffer(30 + fileName.length);
    const lv = new DataView(localHeader);
    writeU32(lv, 0, 0x04034B50);   // signature
    writeU16(lv, 4, 20);            // version needed
    writeU16(lv, 6, 0x0800);        // flags (UTF-8)
    writeU16(lv, 8, compressionMethod);
    writeU16(lv, 10, dt.time);
    writeU16(lv, 12, dt.date);
    writeU32(lv, 14, crc);
    writeU32(lv, 18, compressedSize);
    writeU32(lv, 22, uncompressedSize);
    writeU16(lv, 26, fileName.length);
    writeU16(lv, 28, 0);            // extra field length
    new Uint8Array(localHeader).set(fileName, 30);

    // Central directory entry (46 bytes + filename)
    const cdEntry = new ArrayBuffer(46 + fileName.length);
    const cv = new DataView(cdEntry);
    writeU32(cv, 0, 0x02014B50);    // signature
    writeU16(cv, 4, 20);            // version made by
    writeU16(cv, 6, 20);            // version needed
    writeU16(cv, 8, 0x0800);        // flags (UTF-8)
    writeU16(cv, 10, compressionMethod);
    writeU16(cv, 12, dt.time);
    writeU16(cv, 14, dt.date);
    writeU32(cv, 16, crc);
    writeU32(cv, 20, compressedSize);
    writeU32(cv, 24, uncompressedSize);
    writeU16(cv, 28, fileName.length);
    writeU16(cv, 30, 0);            // extra field length
    writeU16(cv, 32, 0);            // comment length
    writeU16(cv, 34, 0);            // disk number
    writeU16(cv, 36, 0);            // internal attrs
    writeU32(cv, 38, 0);            // external attrs
    writeU32(cv, 42, offset);       // local header offset
    new Uint8Array(cdEntry).set(fileName, 46);

    blobParts.push(new Uint8Array(localHeader));
    blobParts.push(compressed);
    centralEntries.push(new Uint8Array(cdEntry));

    offset += localHeader.byteLength + compressedSize;
    unflushedBytes += localHeader.byteLength + compressedSize;
    fileCount += 1;

    if (unflushedBytes >= COMPACT_THRESHOLD) {
      compactParts();
    }
  }

  async function generate(onProgress) {
    const cdOffset = offset;
    let cdSize = 0;
    for (const entry of centralEntries) {
      blobParts.push(entry);
      cdSize += entry.length;
    }

    // End of central directory (22 bytes)
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    writeU32(ev, 0, 0x06054B50);    // signature
    writeU16(ev, 4, 0);             // disk number
    writeU16(ev, 6, 0);             // cd start disk
    writeU16(ev, 8, fileCount);     // entries on this disk
    writeU16(ev, 10, fileCount);    // total entries
    writeU32(ev, 12, cdSize);       // cd size
    writeU32(ev, 16, cdOffset);     // cd offset
    writeU16(ev, 20, 0);            // comment length
    blobParts.push(new Uint8Array(eocd));

    if (typeof onProgress === "function") {
      onProgress(1);
    }

    return new Blob(blobParts, { type: "application/zip" });
  }

  return {
    addFile,
    generate
  };
}
