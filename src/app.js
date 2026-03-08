import { createUIController } from "./ui.js";
import { createZipBuilder, createStreamingZipBuilder } from "./zip.js";

const STAGE_WEIGHTS = {
  reading: 0.12,
  segmenting: 0.12,
  chunking: 0.12,
  concept_extraction: 0.14,
  artifact_promotion: 0.08,
  textpack_build: 0.16,
  textpack_validate: 0.06,
  graph_build: 0.1,
  symbolic_streams: 0.04,
  finalize: 0.06,
  archive_generation: 0.1
};

const WORKER_VERSION = "20260308-02";

const STAGE_LABELS = {
  reading: "Reading input file...",
  segmenting: "Segmenting sessions...",
  chunking: "Building chunks...",
  concept_extraction: "Extracting recurring concepts...",
  artifact_promotion: "Promoting structured artifacts...",
  textpack_build: "Encoding textpack payloads...",
  textpack_validate: "Validating textpack reconstruction...",
  graph_build: "Building graph artifacts...",
  symbolic_streams: "Generating symbolic streams...",
  finalize: "Preparing output files...",
  archive_generation: "Generating ZIP archive..."
};

const ui = createUIController();
ui.resetProgress();

const state = {
  running: false,
  startedAt: 0,
  timerId: null,
  worker: null,
  zipBuilder: null,
  useStreamingZip: false,
  stageProgress: Object.create(null),
  objectUrl: null,
  warnings: [],
  inputFile: null
};

ui.onGenerate(() => {
  startGeneration().catch((error) => {
    failGeneration(error);
  });
});

const splitObjectUrls = [];

ui.onSplit(() => {
  const file = ui.getSelectedFile();
  if (!file) {
    return;
  }

  for (const url of splitObjectUrls) {
    URL.revokeObjectURL(url);
  }
  splitObjectUrls.length = 0;

  const SPLIT_SIZE = 190 * 1024 * 1024;
  const partCount = Math.ceil(file.size / SPLIT_SIZE);
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
  const links = [];

  for (let i = 0; i < partCount; i++) {
    const start = i * SPLIT_SIZE;
    const end = Math.min(start + SPLIT_SIZE, file.size);
    const blob = file.slice(start, end, file.type || "application/octet-stream");
    const url = URL.createObjectURL(blob);
    const filename = `${baseName}_part${i + 1}_of_${partCount}${ext}`;
    splitObjectUrls.push(url);
    links.push({ url, filename, size: end - start });
  }

  ui.showSplitLinks(links);
  ui.setStatus(`File split into ${partCount} parts. Download each and process individually.`);
});

async function startGeneration() {
  if (state.running) {
    return;
  }

  const file = ui.getSelectedFile();
  if (!file) {
    ui.setStatus("Select a .txt, .html, or .json file first.");
    return;
  }

  if (!isSupportedInputFile(file)) {
    ui.setStatus("Please choose a supported text file (.txt, .html/.htm, or .json).");
    return;
  }

  await ensureJsZipLoaded();
  resetRunState();

  const STREAMING_ZIP_THRESHOLD = 200 * 1024 * 1024;
  state.running = true;
  state.startedAt = performance.now();
  state.warnings = [];
  state.inputFile = file;
  state.useStreamingZip = file.size > STREAMING_ZIP_THRESHOLD;
  state.zipBuilder = state.useStreamingZip ? createStreamingZipBuilder() : createZipBuilder();
  ui.setBusy(true);
  ui.setProgress(0, STAGE_LABELS.reading);
  ui.setTiming(0, Number.NaN);

  state.timerId = window.setInterval(() => {
    renderTiming();
  }, 300);

  const workerUrl = new URL("./worker.js", import.meta.url);
  workerUrl.searchParams.set("v", WORKER_VERSION);
  const worker = new Worker(workerUrl, { type: "module" });
  state.worker = worker;

  worker.addEventListener("message", async (event) => {
    try {
      await handleWorkerMessage(event.data);
    } catch (error) {
      failGeneration(error);
    }
  });

  worker.addEventListener("error", (event) => {
    const detail = event.message || event.error?.message || "";
    const loc = event.filename ? ` at ${event.filename}:${event.lineno}` : "";
    failGeneration(event.error || new Error(`Worker crashed.${detail ? " " + detail : ""}${loc}`));
  });

  worker.postMessage({
    type: "start",
    file,
    settings: ui.getSettings()
  });
}

async function handleWorkerMessage(message) {
  if (!message || !state.running) {
    return;
  }

  if (message.type === "progress") {
    const stage = message.stage;
    if (!Object.prototype.hasOwnProperty.call(STAGE_WEIGHTS, stage)) {
      return;
    }

    state.stageProgress[stage] = boundedProgress(message.stageProgress);
    const status = message.status || STAGE_LABELS[stage] || "Working...";
    const progress = computeOverallProgress();
    ui.setProgress(progress * 100, status);
    renderTiming(progress);
    return;
  }

  if (message.type === "warning") {
    if (message.warning && !state.warnings.includes(message.warning)) {
      state.warnings.push(message.warning);
      ui.setWarnings(state.warnings);
    }
    return;
  }

  if (message.type === "file_batch") {
    if (!state.zipBuilder) {
      state.zipBuilder = state.useStreamingZip ? createStreamingZipBuilder() : createZipBuilder();
    }

    for (const entry of message.files || []) {
      await state.zipBuilder.addFile(entry);
    }
    return;
  }

  if (message.type === "complete") {
    state.stageProgress.finalize = 1;
    ui.setProgress(computeOverallProgress() * 100, STAGE_LABELS.archive_generation);

    if (!state.zipBuilder) {
      state.zipBuilder = state.useStreamingZip ? createStreamingZipBuilder() : createZipBuilder();
    }

    if (Array.isArray(message.rawFilePlan) && state.inputFile) {
      for (const plan of message.rawFilePlan) {
        if (!plan || typeof plan.path !== "string") {
          continue;
        }

        const start = Number.isFinite(plan.start) ? Math.max(0, plan.start) : 0;
        const end = Number.isFinite(plan.end) ? Math.max(start, plan.end) : state.inputFile.size;
        const shardBlob = state.inputFile.slice(start, end);

        await state.zipBuilder.addFile({
          path: plan.path,
          content: shardBlob,
          options: {
            compression: plan.compression || (shardBlob.size > 25 * 1024 * 1024 ? "STORE" : "DEFLATE")
          }
        });
      }
    }

    const zipBlob = await state.zipBuilder.generate((archiveProgress) => {
      state.stageProgress.archive_generation = boundedProgress(archiveProgress);
      const overall = computeOverallProgress();
      ui.setProgress(overall * 100, STAGE_LABELS.archive_generation);
      renderTiming(overall);
    });

    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
    }

    state.objectUrl = URL.createObjectURL(zipBlob);
    ui.setDownload(state.objectUrl, message.downloadName);

    const summary = message.report;
    const doneStatus = `Done. ${summary.total_sessions} sessions, ${summary.total_chunks} chunks, ${summary.total_concepts} concepts, ${summary.total_edges} edges, ${summary.total_artifact_versions || 0} artifact versions.`;

    if (Array.isArray(message.warnings)) {
      for (const warning of message.warnings) {
        if (warning && !state.warnings.includes(warning)) {
          state.warnings.push(warning);
        }
      }
    }

    ui.setWarnings(state.warnings);
    state.stageProgress.archive_generation = 1;
    ui.setProgress(100, doneStatus);
    renderTiming(1);
    finishGeneration();
    return;
  }

  if (message.type === "error") {
    throw new Error(message.error || "Generation failed.");
  }
}

function finishGeneration() {
  state.running = false;
  ui.setBusy(false);

  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  state.zipBuilder = null;
}

function failGeneration(error) {
  console.error(error);
  const message = error instanceof Error ? error.message : "Generation failed.";
  ui.setStatus(`Error: ${message}`);
  state.warnings.push("Generation did not finish. Review the error and retry with a smaller file if needed.");
  ui.setWarnings(state.warnings);
  finishGeneration();
}

function resetRunState() {
  state.stageProgress = Object.create(null);
  state.warnings = [];
  state.inputFile = null;
  state.zipBuilder = null;
  ui.setWarnings([]);
  ui.setDownload(null, null);
}

function renderTiming(progressOverride) {
  if (!state.startedAt) {
    return;
  }

  const elapsed = performance.now() - state.startedAt;
  const progress = typeof progressOverride === "number" ? progressOverride : computeOverallProgress();

  let eta = Number.NaN;
  if (progress > 0.01 && progress < 1) {
    eta = elapsed * ((1 - progress) / progress);
  }

  ui.setTiming(elapsed, eta);
}

function computeOverallProgress() {
  let total = 0;
  for (const [stage, weight] of Object.entries(STAGE_WEIGHTS)) {
    total += (state.stageProgress[stage] || 0) * weight;
  }
  return Math.max(0, Math.min(1, total));
}

function boundedProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(1, number));
}

function isSupportedInputFile(file) {
  const lower = file.name.toLowerCase();
  const extensionSupported = [".txt", ".md", ".log", ".html", ".htm", ".json"].some((ext) => lower.endsWith(ext));
  if (extensionSupported) {
    return true;
  }

  const mime = (file.type || "").toLowerCase();
  return mime.startsWith("text/") || mime.includes("json") || mime.includes("html");
}

async function ensureJsZipLoaded() {
  if (window.JSZip) {
    return;
  }

  await tryLoadScript("./vendor/jszip.min.js").catch(() => null);
  if (window.JSZip) {
    return;
  }

  await tryLoadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  if (!window.JSZip) {
    throw new Error("Unable to load JSZip.");
  }
}

function tryLoadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load script: ${src}`));
    document.head.appendChild(script);
  });
}
