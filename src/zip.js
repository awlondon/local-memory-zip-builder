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

