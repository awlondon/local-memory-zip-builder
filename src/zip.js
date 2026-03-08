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

// ── Streaming zip builder (STORE, no JSZip) ──────────────────────────────────
// Processes files one-at-a-time so only one file's raw bytes are in memory at
// any given time. Uses STORE compression (no deflate) to avoid memory
// amplification. Final zip is assembled as a Blob from pre-built parts.

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
    const size = data.length;
    const dt = dosDateTime();

    // Local file header (30 bytes + filename)
    const localHeader = new ArrayBuffer(30 + fileName.length);
    const lv = new DataView(localHeader);
    writeU32(lv, 0, 0x04034B50);   // signature
    writeU16(lv, 4, 20);            // version needed
    writeU16(lv, 6, 0x0800);        // flags (UTF-8)
    writeU16(lv, 8, 0);             // compression: STORE
    writeU16(lv, 10, dt.time);
    writeU16(lv, 12, dt.date);
    writeU32(lv, 14, crc);
    writeU32(lv, 18, size);         // compressed size
    writeU32(lv, 22, size);         // uncompressed size
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
    writeU16(cv, 10, 0);            // compression: STORE
    writeU16(cv, 12, dt.time);
    writeU16(cv, 14, dt.date);
    writeU32(cv, 16, crc);
    writeU32(cv, 20, size);         // compressed size
    writeU32(cv, 24, size);         // uncompressed size
    writeU16(cv, 28, fileName.length);
    writeU16(cv, 30, 0);            // extra field length
    writeU16(cv, 32, 0);            // comment length
    writeU16(cv, 34, 0);            // disk number
    writeU16(cv, 36, 0);            // internal attrs
    writeU32(cv, 38, 0);            // external attrs
    writeU32(cv, 42, offset);       // local header offset
    new Uint8Array(cdEntry).set(fileName, 46);

    blobParts.push(new Uint8Array(localHeader));
    blobParts.push(data);
    centralEntries.push(new Uint8Array(cdEntry));

    offset += localHeader.byteLength + data.length;
    unflushedBytes += localHeader.byteLength + data.length;
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
