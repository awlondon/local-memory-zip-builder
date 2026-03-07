function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "--:--";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function createUIController() {
  const elements = {
    dropZone: document.getElementById("drop-zone"),
    dropLabel: document.getElementById("drop-label"),
    fileInput: document.getElementById("file-input"),
    selectedFile: document.getElementById("selected-file"),
    sessionSize: document.getElementById("session-size"),
    conceptAggressiveness: document.getElementById("concept-aggressiveness"),
    includeSymbolic: document.getElementById("include-symbolic"),
    includeTextpack: document.getElementById("include-textpack"),
    includeLegacyChunkText: document.getElementById("include-legacy-chunk-text"),
    includeRaw: document.getElementById("include-raw"),
    generateBtn: document.getElementById("generate-btn"),
    downloadBtn: document.getElementById("download-btn"),
    progress: document.getElementById("progress"),
    progressLabel: document.getElementById("progress-label"),
    statusLine: document.getElementById("status-line"),
    elapsed: document.getElementById("elapsed"),
    eta: document.getElementById("eta"),
    warnings: document.getElementById("warnings")
  };

  let selectedFile = null;

  function applyFileSelection(file) {
    selectedFile = file ?? null;
    if (!selectedFile) {
      elements.selectedFile.textContent = "No file selected.";
      elements.dropLabel.textContent = "Drop .txt file here or click to browse";
      return;
    }

    elements.selectedFile.textContent = `Selected: ${selectedFile.name} (${formatBytes(selectedFile.size)})`;
    elements.dropLabel.textContent = `Ready: ${selectedFile.name}`;
  }

  function bindInputEvents() {
    const { dropZone, fileInput } = elements;

    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
      }
    });

    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropZone.classList.remove("drag-over");
      const [file] = event.dataTransfer?.files ?? [];
      if (file) {
        applyFileSelection(file);
      }
    });

    fileInput.addEventListener("change", () => {
      const [file] = fileInput.files ?? [];
      if (file) {
        applyFileSelection(file);
      }
    });
  }

  function setBusy(busy) {
    elements.generateBtn.disabled = busy;
    elements.sessionSize.disabled = busy;
    elements.conceptAggressiveness.disabled = busy;
    elements.includeSymbolic.disabled = busy;
    elements.includeTextpack.disabled = busy;
    elements.includeLegacyChunkText.disabled = busy;
    elements.includeRaw.disabled = busy;
    elements.fileInput.disabled = busy;
    elements.dropZone.classList.toggle("disabled", busy);
  }

  function setProgress(percent, status) {
    const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
    elements.progress.value = bounded;
    elements.progressLabel.textContent = `${bounded.toFixed(1)}%`;
    if (status) {
      elements.statusLine.textContent = status;
    }
  }

  function setTiming(elapsedMs, etaMs) {
    elements.elapsed.textContent = `Elapsed: ${formatTime(elapsedMs)}`;
    elements.eta.textContent = `ETA: ${formatTime(etaMs)}`;
  }

  function setWarnings(warnings) {
    const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    elements.warnings.innerHTML = "";
    if (!list.length) {
      elements.warnings.classList.add("hidden");
      return;
    }

    for (const warning of list) {
      const item = document.createElement("li");
      item.textContent = warning;
      elements.warnings.appendChild(item);
    }
    elements.warnings.classList.remove("hidden");
  }

  function setDownload(url, filename) {
    if (!url) {
      elements.downloadBtn.removeAttribute("href");
      elements.downloadBtn.classList.add("hidden");
      elements.downloadBtn.textContent = "Download ZIP";
      return;
    }

    elements.downloadBtn.href = url;
    elements.downloadBtn.download = filename;
    elements.downloadBtn.classList.remove("hidden");
    elements.downloadBtn.textContent = `Download ${filename}`;
  }

  function getSettings() {
    return {
      sessionSize: elements.sessionSize.value,
      conceptAggressiveness: elements.conceptAggressiveness.value,
      includeSymbolic: elements.includeSymbolic.checked,
      includeTextpack: elements.includeTextpack.checked,
      includeLegacyChunkText: elements.includeLegacyChunkText.checked,
      includeRaw: elements.includeRaw.checked,
      enableDeltaEncoding: true
    };
  }

  function onGenerate(handler) {
    elements.generateBtn.addEventListener("click", () => handler());
  }

  function getSelectedFile() {
    return selectedFile;
  }

  bindInputEvents();

  return {
    getSelectedFile,
    getSettings,
    onGenerate,
    setBusy,
    setProgress,
    setTiming,
    setWarnings,
    setDownload,
    setStatus(message) {
      elements.statusLine.textContent = message;
    },
    resetProgress() {
      setProgress(0, "Idle.");
      setTiming(0, Number.NaN);
      setWarnings([]);
      setDownload(null, null);
    }
  };
}
