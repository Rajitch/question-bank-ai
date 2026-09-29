import { createWorker } from "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js";

const CORE_PATH = "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2";
const WORKER_PATH = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js";

let ocr = null;
let currentLanguage = null;

self.addEventListener("message", async (event) => {
  const msg = event.data || {};

  try {
    if (msg.type === "initialize") {
      await ensureOCR(msg.language || "eng");
      self.postMessage({ type: "ready", language: currentLanguage });
      return;
    }

    if (msg.type === "ocr") {
      const language = msg.language || "eng";
      await ensureOCR(language);

      const page = msg.pageNumber || 1;
      const total = msg.totalPages || 1;

      self.postMessage({
        type: "progress",
        percent: 5 + Math.round((page / total) * 35),
        title: "Local OCR",
        message: `OCR page ${page} of ${total}…`
      });

      const result = await ocr.recognize(msg.image);

      self.postMessage({
        type: "ocr-result",
        requestId: msg.requestId,
        pageNumber: page,
        text: result?.data?.text || ""
      });
      return;
    }
  } catch (error) {
    self.postMessage({
      type: msg.type === "ocr" ? "ocr-result" : "error",
      requestId: msg.requestId,
      error: error?.message || String(error),
      message: error?.message || String(error)
    });
  }
});

async function ensureOCR(language) {
  if (ocr && currentLanguage === language) return;

  if (ocr) {
    try { await ocr.terminate(); } catch {}
    ocr = null;
  }

  self.postMessage({
    type: "progress",
    percent: 8,
    title: "Preparing local OCR",
    message: `Loading Tesseract language data: ${language}…`
  });

  ocr = await createWorker(language, 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    logger: (m) => {
      if (typeof m?.progress === "number") {
        self.postMessage({
          type: "progress",
          percent: Math.max(8, Math.min(39, Math.round(m.progress * 31))),
          title: "Local OCR",
          message: m.status ? `${m.status}…` : "OCR engine working…"
        });
      }
    }
  });

  currentLanguage = language;
}

self.addEventListener("close", async () => {
  if (ocr) {
    try { await ocr.terminate(); } catch {}
  }
});
