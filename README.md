# Local AI Question Bank Generator — PDF + OCR + WebGPU/WASM

A completely client-side static web application.

## Pipeline

PDF
→ PDF.js text extraction
→ page-level text-density test
→ local Tesseract.js OCR for text-poor pages
→ unified source document
→ Transformers.js Llama 3.2 1B
→ Question Generation
→ Question Bank Quality Gate
→ PASS / FAIL / REVIEW

## Files

- `index.html` — UI and pinned CDN imports
- `main.js` — PDF parsing, page rendering, OCR orchestration, UI
- `ocr-worker.js` — local Tesseract.js OCR worker
- `worker.js` — Transformers.js LLM worker and both prompts
- `README.md` — deployment/testing instructions

## Important privacy property

The application does not send the uploaded PDF, extracted text, OCR output, generated questions, or validation report to an application backend.

The browser does download the open-source model and OCR assets from their CDNs on first use.

## OCR behavior

Each PDF page is first inspected with PDF.js.

Default "Balanced" threshold:

- fewer than 220 extracted characters, OR
- fewer than 30 extracted words

→ render page locally at 2x resolution → OCR locally.

You can change the threshold:

- Strict — OCR only very text-poor pages
- Balanced — recommended
- Aggressive — OCR more pages

The OCR language selector supports:

- English
- Bengali
- Hindi
- English + Bengali
- English + Hindi

For textbook PDFs with diagrams containing labels, tables, or scanned pages, the OCR path can recover text that PDF.js cannot extract.

## Important limitation

OCR is not perfect. The Quality Gate is explicitly instructed not to correct OCR errors using outside knowledge. If OCR evidence is unclear, the validator should mark the affected question REVIEW.

## Local testing

Do NOT double-click `index.html`.

Browsers restrict some worker/module behavior from `file://`.

Use a local static server.

### Option A — Python

```bash
python -m http.server 8080
```

Then open:

http://localhost:8080

### Option B — VS Code

Install the Live Server extension and open the project using Live Server.

## Cloudflare Pages

This project has no build step.

Upload the four application files to a GitHub repository:

```text
index.html
main.js
ocr-worker.js
worker.js
README.md
```

Then in Cloudflare Pages:

1. Create a new Pages project.
2. Connect the GitHub repository.
3. Framework preset: None / blank.
4. Build command: leave empty.
5. Build output directory: `/` or the repository root.
6. Deploy.

There is no server-side runtime in this project.

## First-run downloads

The first run can take significant time because the browser must download:

1. Transformers.js runtime
2. Llama model files
3. Tesseract.js runtime
4. Tesseract core WASM
5. OCR language data

Browser caching can reduce repeat downloads.

## Recommended browser

Use a current Chromium-based browser with WebGPU enabled for best LLM performance.

If WebGPU cannot initialize, the LLM worker falls back to WASM.

OCR uses WebAssembly.

## Model

Default:

`onnx-community/Llama-3.2-1B-Instruct-q4f16`

The model is executed locally through Transformers.js.

## Changing the prompts

Edit only these constants in `worker.js`:

```javascript
const GENERATION_PROMPT = `...`;
const VALIDATION_PROMPT = `...`;
```

The rest of the pipeline remains unchanged.

## Changing the model

Edit:

```javascript
const MODEL_ID = "onnx-community/Llama-3.2-1B-Instruct-q4f16";
```

Choose a Transformers.js-compatible text-generation model that fits the user's device.

## Architecture

```text
                         ┌───────────────┐
                         │      PDF      │
                         └───────┬───────┘
                                 │
                         ┌───────▼───────┐
                         │    PDF.js     │
                         └───────┬───────┘
                                 │
                       ┌─────────▼─────────┐
                       │ Text available?   │
                       └─────────┬─────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   │                           │
                  YES                          NO
                   │                           │
                   │                    ┌──────▼──────┐
                   │                    │ Local OCR    │
                   │                    │ Tesseract.js │
                   │                    └──────┬───────┘
                   │                           │
                   └─────────────┬─────────────┘
                                 │
                         ┌───────▼────────┐
                         │ SOURCE DOCUMENT│
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ LLM GENERATION │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ QUESTION BANK  │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ LLM QUALITY    │
                         │ GATE           │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ PASS / FAIL /  │
                         │ REVIEW         │
                         └────────────────┘
```

## Device Compatibility Check

The application now includes **Check My Device** before generation. It checks:

- Web Worker support
- WebAssembly support
- Secure context (HTTPS/localhost)
- WebGPU API availability
- WebGPU adapter/device creation
- A real short inference using the same local Llama 3.2 1B model used by generation
- The actual AI runtime selected by the worker: WebGPU or WASM

A WebGPU API check alone is not sufficient: a device can expose WebGPU but still fail to create a usable device or run the model. The final AI inference check catches that case.

### Recommended client requirements

- 8 GB RAM minimum; 16 GB recommended
- Modern 4-core 64-bit CPU minimum
- Modern GPU/integrated GPU with WebGPU strongly recommended
- 5 GB free storage recommended for browser cache/model assets
- Latest stable Google Chrome or Microsoft Edge recommended
- HTTPS or localhost
- WebGPU is strongly recommended; WASM fallback is available but can be much slower

The first AI compatibility test may download the model. On a slow connection or low-end device this can take several minutes. After browser caching, subsequent tests can be substantially faster.


## v3 model-loading fix (Cloudflare Pages Direct Upload)

This version intentionally contains **no `_worker.js` and no `wrangler.jsonc`**. It is compatible with Cloudflare Pages Direct Upload.

The browser LLM now tries two model hosts in order:
1. Hugging Face Hub (authoritative source)
2. `hf-mirror.com` as a browser-CORS fallback when the Hugging Face Xet storage redirect is blocked by the browser

Inference remains entirely local in the browser. The mirror is only used to download/cache model files; it does not perform inference.

### Important long-term note
The mirror is a third-party service and is not controlled by this project. If it is unavailable in a particular network, the application reports the model-host failure instead of silently using a cloud inference API.

### Cloudflare Pages Direct Upload
Upload **only the contents of this project folder**. Do not upload Wrangler configuration files; this build has none.
