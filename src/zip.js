const DETERMINISTIC_DATE = new Date(0);

export async function createZipBlob(files, onProgress) {
  if (!window.JSZip) {
    throw new Error("JSZip is not loaded.");
  }

  const zip = new window.JSZip();

  for (const entry of files) {
    zip.file(entry.path, entry.content, {
      binary: false,
      createFolders: true,
      date: DETERMINISTIC_DATE
    });
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
