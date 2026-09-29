const aiWorker = new Worker("./worker.js", { type: "module" });
const ocrWorker = new Worker("./ocr-worker.js", { type: "module" });

const $ = (id) => document.getElementById(id);
const dropZone = $("dropZone");
const pdfInput = $("pdfInput");
const bookName = $("bookName");
const chapterName = $("chapterName");
const questionCount = $("questionCount");
const ocrLanguage = $("ocrLanguage");
const ocrThreshold = $("ocrThreshold");
const generateButton = $("generateButton");
const downloadButton = $("downloadButton");
const fileInfo = $("fileInfo");
const runtimeInfo = $("runtimeInfo");
const ocrInfo = $("ocrInfo");
const progressSection = $("progressSection");
const progressBar = $("progressBar");
const progressTitle = $("progressTitle");
const progressPercent = $("progressPercent");
const statusLine = $("statusLine");
const errorBox = $("errorBox");
const questionList = $("questionList");
const questionSummary = $("questionSummary");
const validationReport = $("validationReport");
const sourceStats = $("sourceStats");
const compatButton = $("compatButton");
const compatSummary = $("compatSummary");
const compatResults = $("compatResults");

let selectedFile = null;
let sourceDocument = "";
let sourceDiagnostics = null;
let latestResult = null;
let workerBusy = false;
let ocrReady = false;
let ocrRequestId = 0;
const pendingOCR = new Map();

runtimeInfo.textContent =
  navigator.gpu ? "WebGPU available → GPU first" : "WebGPU unavailable → WASM fallback";

compatButton.addEventListener("click", runCompatibilityCheck);

async function runCompatibilityCheck() {
  compatButton.disabled = true;
  compatButton.textContent = "Testing…";
  compatResults.style.display = "grid";
  compatResults.innerHTML = "";
  compatSummary.textContent = "Running browser, WebGPU, worker, WASM and local-AI checks…";
  clearError();

  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  add("Browser", "pass", `${navigator.userAgentData?.brands?.map(x => `${x.brand} ${x.version}`).join(", ") || navigator.userAgent}`);
  add("Web Worker", typeof Worker === "function" ? "pass" : "fail", typeof Worker === "function" ? "Supported" : "Web Workers are unavailable.");
  add("WebAssembly", typeof WebAssembly === "object" ? "pass" : "fail", typeof WebAssembly === "object" ? "Supported" : "WebAssembly is unavailable.");
  add("Secure context", window.isSecureContext ? "pass" : "warn", window.isSecureContext ? "HTTPS/localhost context" : "Use HTTPS or localhost for best compatibility.");

  let gpuInfo = null;
  if (!navigator.gpu) {
    add("WebGPU API", "fail", "navigator.gpu is unavailable. The app can fall back to WASM, but AI will be slower.");
  } else {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No WebGPU adapter was returned.");
      const device = await adapter.requestDevice();
      gpuInfo = {
        adapter,
        architecture: adapter.info?.architecture || "unknown",
        vendor: adapter.info?.vendor || "unknown",
        description: adapter.info?.description || "unknown",
        maxBufferSize: device.limits?.maxBufferSize || null
      };
      add("WebGPU API", "pass", `Adapter available • ${gpuInfo.description !== "unknown" ? gpuInfo.description : "GPU adapter detected"}`);
      add("WebGPU device", "pass", `Vendor: ${gpuInfo.vendor} • Architecture: ${gpuInfo.architecture}`);
      device.destroy?.();
    } catch (error) {
      add("WebGPU device", "warn", `WebGPU is exposed but could not create a device: ${error?.message || error}`);
    }
  }

  renderCompatibilityChecks(checks);
  compatSummary.textContent = "Hardware/browser checks complete. Running a real short AI inference using the same model as generation…";

  try {
    const result = await requestCompatibilityAI();
    add("Local LLM inference", result.ok ? "pass" : "fail", result.detail);
    if (result.device) add("AI execution", "pass", `Actual model runtime: ${result.device}`);
  } catch (error) {
    add("Local LLM inference", "fail", error?.message || String(error));
  }

  renderCompatibilityChecks(checks);
  const failures = checks.filter(x => x.status === "fail").length;
  const warnings = checks.filter(x => x.status === "warn").length;
  if (failures === 0 && warnings === 0) {
    compatSummary.textContent = "READY — this device passed the compatibility checks, including a real local AI inference.";
  } else if (failures === 0) {
    compatSummary.textContent = `READY WITH ${warnings} WARNING${warnings === 1 ? "" : "S"} — the application can run, but review the warnings below.`;
  } else {
    compatSummary.textContent = `NOT READY — ${failures} check${failures === 1 ? "" : "s"} failed. Review the results below; WASM fallback may still work if the failed check is WebGPU.`;
  }
  compatButton.disabled = false;
  compatButton.textContent = "Run Check Again";
}

function requestCompatibilityAI() {
  const requestId = `compat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const msg = event.data || {};
      if (msg.type === "compatibility-result" && msg.requestId === requestId) {
        aiWorker.removeEventListener("message", handler);
        resolve(msg);
      } else if (msg.type === "compatibility-error" && msg.requestId === requestId) {
        aiWorker.removeEventListener("message", handler);
        reject(new Error(msg.message || "Local AI compatibility test failed."));
      }
    };
    aiWorker.addEventListener("message", handler);
    aiWorker.postMessage({ type: "compatibility-test", requestId });
  });
}

function renderCompatibilityChecks(checks) {
  compatResults.innerHTML = checks.map(check => {
    const label = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARNING" : "FAIL";
    return `<div class="compat-item compat-${check.status}"><strong>${escapeHtml(label)} • ${escapeHtml(check.name)}</strong><span>${escapeHtml(check.detail)}</span></div>`;
  }).join("");
}

dropZone.addEventListener("click", () => pdfInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pdfInput.click(); }
});
pdfInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files?.[0];
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("Please select a PDF file.");
    return;
  }
  handleFile(file);
});

ocrWorker.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "ready") {
    ocrReady = true;
    ocrInfo.textContent = "OCR: ready on demand";
    return;
  }
  if (msg.type === "progress") {
    setProgress(msg.percent ?? 0, msg.title ?? "OCR", msg.message ?? "");
    return;
  }
  if (msg.type === "ocr-result") {
    const pending = pendingOCR.get(msg.requestId);
    if (!pending) return;
    pendingOCR.delete(msg.requestId);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg);
    return;
  }
  if (msg.type === "error") {
    ocrInfo.textContent = "OCR: error";
    for (const [id, pending] of pendingOCR) {
      pending.reject(new Error(msg.message || "OCR worker failed."));
      pendingOCR.delete(id);
    }
  }
});

aiWorker.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "ready") {
    runtimeInfo.textContent = `AI runtime ready • ${msg.device}`;
    return;
  }
  if (msg.type === "progress") {
    setProgress(msg.percent ?? 0, msg.title ?? "AI processing", msg.message ?? "");
    return;
  }
  if (msg.type === "result") {
    workerBusy = false;
    generateButton.disabled = false;
    downloadButton.disabled = false;
    latestResult = msg.result;
    renderResult(latestResult);
    setProgress(100, "Complete", "Question generation and validation finished locally.");
    return;
  }
  if (msg.type === "error") {
    workerBusy = false;
    generateButton.disabled = false;
    showError(msg.message || "The local AI pipeline failed.");
  }
});

async function handleFile(file) {
  clearError();
  selectedFile = file;
  fileInfo.textContent = `${file.name} • ${formatBytes(file.size)}`;
  generateButton.disabled = true;
  downloadButton.disabled = true;
  sourceStats.style.display = "none";
  progressSection.style.display = "block";
  setProgress(2, "Reading PDF", "Loading the PDF locally…");

  try {
    const result = await buildSourceDocument(file);
    sourceDocument = result.sourceDocument;
    sourceDiagnostics = result.diagnostics;

    $("pageCount").textContent = result.diagnostics.totalPages;
    $("textPages").textContent = result.diagnostics.textPages;
    $("ocrPages").textContent = result.diagnostics.ocrPages;
    $("sourceChars").textContent = result.sourceDocument.length.toLocaleString();
    sourceStats.style.display = "grid";

    ocrInfo.textContent =
      result.diagnostics.ocrPages
        ? `OCR: ${result.diagnostics.ocrPages} page(s) processed`
        : "OCR: not needed";

    setProgress(25, "Source ready",
      `${result.diagnostics.ocrPages} page(s) used OCR; ${result.diagnostics.textPages} page(s) used PDF.js text.`);
    generateButton.disabled = false;
  } catch (error) {
    console.error(error);
    showError(error?.message || "Unable to process the PDF.");
  }
}

async function buildSourceDocument(file) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error("PDF.js has not finished loading.");

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const threshold = getOCRThreshold();
  const pageRecords = [];
  let textPages = 0;
  let ocrPages = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let currentLine = [];
    let lastY = null;

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = String(item.str || "").trim();
      if (!text) continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        if (currentLine.length) lines.push(currentLine.join(" "));
        currentLine = [];
      }
      currentLine.push(text);
      lastY = y;
    }
    if (currentLine.length) lines.push(currentLine.join(" "));

    const pdfText = lines.join("\n").trim();
    const words = pdfText ? pdfText.split(/\s+/).filter(Boolean).length : 0;
    const shouldOCR = pdfText.length < threshold.minChars || words < threshold.minWords;

    setProgress(
      3 + Math.round((pageNumber / pdf.numPages) * 18),
      "Inspecting PDF pages",
      `Page ${pageNumber} of ${pdf.numPages} • ${shouldOCR ? "OCR required" : "selectable text found"}`
    );

    if (!shouldOCR) {
      textPages++;
      pageRecords.push({
        pageNumber,
        mode: "PDF_TEXT",
        text: pdfText
      });
      continue;
    }

    const imageBlob = await renderPageToBlob(page, 2.0);
    const ocrResult = await requestOCR(imageBlob, ocrLanguage.value, pageNumber, pdf.numPages);
    ocrPages++;

    const ocrText = String(ocrResult.text || "").trim();
    const combined = [pdfText, ocrText]
      .filter(Boolean)
      .join("\n")
      .trim();

    pageRecords.push({
      pageNumber,
      mode: "OCR",
      text: combined
    });

    if (imageBlob?.close) imageBlob.close?.();
  }

  const sourceDocument = pageRecords.map((record) =>
    `===== PAGE ${record.pageNumber} | ${record.mode} =====\n${record.text || "[NO TEXT EXTRACTED]"}`
  ).join("\n\n");

  return {
    sourceDocument,
    diagnostics: {
      totalPages: pdf.numPages,
      textPages,
      ocrPages,
      pages: pageRecords.map(({ pageNumber, mode, text }) => ({
        pageNumber, mode, characters: text.length
      }))
    }
  };
}

function getOCRThreshold() {
  const mode = ocrThreshold.value;
  if (mode === "strict") return { minChars: 80, minWords: 12 };
  if (mode === "aggressive") return { minChars: 500, minWords: 60 };
  return { minChars: 220, minWords: 30 };
}

async function renderPageToBlob(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render PDF page for OCR.")), "image/png");
  });
}

function requestOCR(blob, language, pageNumber, totalPages) {
  const requestId = ++ocrRequestId;
  return new Promise((resolve, reject) => {
    pendingOCR.set(requestId, { resolve, reject });
    ocrWorker.postMessage({
      type: "ocr",
      requestId,
      language,
      pageNumber,
      totalPages,
      image: blob
    });
  });
}

generateButton.addEventListener("click", () => {
  if (!sourceDocument.trim() || workerBusy) return;

  workerBusy = true;
  generateButton.disabled = true;
  downloadButton.disabled = true;
  questionList.innerHTML = `<div class="empty-state">Running the local two-pass AI pipeline…</div>`;
  validationReport.textContent = "Running local AI quality gate…";
  questionSummary.innerHTML = "";
  progressSection.style.display = "block";

  const requestedCount = Math.max(1, Math.min(100, Number(questionCount.value) || 20));

  aiWorker.postMessage({
    type: "generate",
    payload: {
      sourceText: sourceDocument,
      sourceDiagnostics,
      book: bookName.value.trim() || "Science",
      chapter: chapterName.value.trim() || "Chapter 1",
      requestedCount
    }
  });
});

function renderResult(result) {
  if (result.questionBank) renderQuestions(result.questionBank, result.validationReport);
  else questionList.innerHTML = `<div class="empty-state">The model did not return a parseable question bank.</div>`;
  validationReport.textContent = result.validationReport || "No validation report returned.";
}

function renderQuestions(questionBank, report) {
  const questions = Array.isArray(questionBank.questions) ? questionBank.questions : [];
  const statuses = extractQuestionStatuses(report);

  if (!questions.length) {
    questionList.innerHTML = `<div class="empty-state">No questions were returned.</div>`;
    return;
  }

  questionList.innerHTML = "";
  let pass = 0, fail = 0, review = 0;

  questions.forEach((q, index) => {
    const status = statuses.get(q.id) || "REVIEW";
    if (status === "PASS") pass++;
    else if (status === "FAIL") fail++;
    else review++;

    const card = document.createElement("article");
    card.className = `question-card ${status.toLowerCase()}`;

    const meta = document.createElement("div");
    meta.className = "question-meta";
    meta.innerHTML = `<span>${escapeHtml(q.id || `Q${index + 1}`)}</span>
      <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>`;

    const text = document.createElement("div");
    text.className = "question-text";
    text.textContent = q.question || "";

    const options = document.createElement("div");
    options.className = "options";
    const answerIndex = Number.isInteger(q.answer) ? q.answer : -1;

    (q.options || []).forEach((option, optionIndex) => {
      const el = document.createElement("div");
      el.className = "option";
      if (optionIndex === answerIndex) el.classList.add("correct");
      el.textContent = `${String.fromCharCode(65 + optionIndex)}. ${option}`;
      options.appendChild(el);
    });

    const explanation = document.createElement("div");
    explanation.style.marginTop = "12px";
    explanation.style.fontSize = "12px";
    explanation.style.color = "#667085";
    explanation.innerHTML = `<strong>Explanation:</strong> ${escapeHtml(q.explanation || "")}`;

    const source = document.createElement("div");
    source.style.marginTop = "8px";
    source.style.fontSize = "11px";
    source.style.color = "#667085";
    source.textContent = `Source: ${q.source || "Not specified"} • Difficulty: ${q.difficulty || "—"} • Topic: ${q.topic || "—"}`;

    card.append(meta, text, options, explanation, source);
    questionList.appendChild(card);
  });

  questionSummary.innerHTML = `
    <span class="status-pill status-pass">PASS ${pass}</span>
    <span class="status-pill status-fail">FAIL ${fail}</span>
    <span class="status-pill status-review">REVIEW ${review}</span>`;
}

function extractQuestionStatuses(report) {
  const map = new Map();
  if (!report) return map;
  for (const line of report.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(x => x.trim());
    if (cells.length < 2) continue;
    const id = cells[0], status = cells[1].toUpperCase();
    if (/^[A-Z0-9_-]+$/i.test(id) && ["PASS", "FAIL", "REVIEW"].includes(status)) map.set(id, status);
  }
  return map;
}

downloadButton.addEventListener("click", () => {
  if (!latestResult) return;
  const output = {
    generatedAt: new Date().toISOString(),
    sourceFile: selectedFile?.name || null,
    sourceDiagnostics,
    questionBank: latestResult.questionBank,
    validationReport: latestResult.validationReport,
    runtimeDevice: latestResult.runtimeDevice,
    model: latestResult.model
  };
  const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "question-bank-quality-gate-result.json";
  link.click();
  URL.revokeObjectURL(url);
});

function setProgress(percent, title, message) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.style.width = `${p}%`;
  progressPercent.textContent = `${p}%`;
  progressTitle.textContent = title;
  statusLine.textContent = message;
}
function showError(message) {
  errorBox.style.display = "block";
  errorBox.textContent = message;
}
function clearError() {
  errorBox.style.display = "none";
  errorBox.textContent = "";
}
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function statusClass(status) {
  if (status === "PASS") return "status-pass";
  if (status === "FAIL") return "status-fail";
  return "status-review";
}

aiWorker.postMessage({ type: "initialize" });
ocrWorker.postMessage({ type: "initialize", language: ocrLanguage.value });
