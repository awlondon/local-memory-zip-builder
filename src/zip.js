const DETERMINISTIC_DATE = new Date(0);

export async function createZipBlob(files, onProgress) {
  if (!window.JSZip) {
    throw new Error("JSZip is not loaded.");
  }

  const zip = new window.JSZip();

  for (const entry of files) {
    const fileOptions = {
      binary: typeof entry.content !== "string",
      createFolders: true,
      date: DETERMINISTIC_DATE,
      ...(entry.options || {})
    };

    zip.file(entry.path, entry.content, fileOptions);
  }

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
