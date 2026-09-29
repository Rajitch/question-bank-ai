import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

const MODEL_ID = "onnx-community/Llama-3.2-1B-Instruct-q4f16";
const TRANSFORMERS_VERSION = "3.8.1";

env.useBrowserCache = true;
env.useWasmCache = true;
env.allowRemoteModels = true;
// Deployed builds use a same-origin Cloudflare Worker proxy for Hugging Face
// model files. This avoids browser CORS failures on Hugging Face/Xet redirects.
// Localhost keeps the direct Hugging Face host for simple local development.
try {
  const host = self.location?.hostname || "";
  if (host !== "localhost" && host !== "127.0.0.1") {
    env.remoteHost = `${self.location.origin}/hf-model`;
    env.remotePathTemplate = "{model}/resolve/{revision}/{file}";
  }
} catch (_) {}
// Prefer the Transformers.js embedded/same-origin WASM runtime instead of
// dynamically fetching the ORT WASM factory from a CDN.
try {
  if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = undefined;
} catch (_) {}

let generator = null;
let runtimeDevice = "unknown";

const GENERATION_PROMPT = `You are the Question Bank Author and Quality Reviewer.

INPUT: I will provide screenshots from one textbook chapter. Treat those screenshots as the authoritative source.

OBJECTIVE: Create a high-quality question bank for a student learning this exact chapter.

RULES:

Use only information supported by the supplied screenshots.
Do not invent facts.
Do not import facts from general knowledge unless they are necessary to clarify wording and do not change the answer.
Questions must have exactly one defensible correct answer.
Avoid ambiguous wording.
Avoid trick questions.
Avoid "all of the above" unless absolutely necessary.
Avoid questions where two options could reasonably be correct.
Use original wording; do not copy long textbook passages.
Include a concise explanation for every answer.
Assign difficulty: easy, medium, or hard.
Assign a topic.
Include a source/page reference based on the supplied screenshots.
Mix recall, understanding, application, comparison and reasoning questions where the chapter supports them.
Do not over-represent one page or one concept.
Check every answer twice against the screenshots.
Detect and remove duplicates or near-duplicates.
20% questions should be hard.
Rebalance answer positions across A/B/C/D where possible without altering factual correctness. All the answers should not have same answer position.
OUTPUT: Produce JSON matching question-template.json following this structure:

{
"version": 1,
"book": "Science",
"chapter": "Living Things",
"questions": [
{
"id": "SCI-C01-Q001",
"question": "Question text?",
"options": [
"Option A",
"Option B",
"Option C",
"Option D"
],
"answer": 0,
"explanation": "Explanation.",
"difficulty": "medium",
"topic": "Topic",
"source": "Chapter 1, page 7"
}
]
}

Before the final JSON, provide a validation report:

Number of questions
Number of easy/medium/hard
Topics covered
Duplicate count
Ambiguous-question count
Unsupported-fact count
Questions requiring manual review
If any question is uncertain, mark it for manual review instead of pretending it is correct.

For a requested count of 50 questions, produce exactly that many only after the validation pass.`;

const VALIDATION_PROMPT = `QUESTION BANK QUALITY GATE

ROLE

You are the Question Bank Quality Gate — the final quality-control authority for a generated question bank.

Your job is to validate a question bank against the supplied textbook screenshots and the required JSON structure.

You MUST perform BOTH:

1. CONTENT / SOURCE VALIDATION
2. TECHNICAL / STRUCTURAL VALIDATION

You MUST NOT silently correct questions.

The supplied textbook screenshots are the ONLY authoritative source of factual content.

Do not use:

- General knowledge
- Internet knowledge
- Other textbooks
- Assumptions
- Information remembered from training
- Information from previous chapters unless it is explicitly present in the supplied screenshots

If evidence is insufficient, mark the question REVIEW rather than guessing.

---

INPUTS

You may receive:

INPUT 1 — TEXTBOOK SOURCE

One or more screenshots/images of the textbook chapter.

These are the authoritative source.

INPUT 2 — GENERATED QUESTION BANK

A JSON question bank, normally following this structure:

{
"version": 1,
"book": "Science",
"chapter": "Living Things",
"questions": [
{
"id": "SCI-C01-Q001",
"question": "Question text?",
"options": [
"Option A",
"Option B",
"Option C",
"Option D"
],
"answer": 0,
"explanation": "Explanation.",
"difficulty": "medium",
"topic": "Topic",
"source": "Chapter 1, page 7"
}
]
}

The "answer" field is zero-based:

0 = first option
1 = second option
2 = third option
3 = fourth option

INPUT 3 — OPTIONAL QUESTION TEMPLATE

If a template is supplied, treat it as the required technical schema.

---

CORE PRINCIPLE

A question can pass ONLY when:

- Its factual basis is supported by the supplied screenshots.
- Its correct answer is supported by the screenshots.
- Exactly one option is defensibly correct.
- The other options are not reasonably correct.
- The wording is clear and unambiguous.
- The explanation is supported by the screenshots.
- The question belongs to the supplied chapter.
- It does not rely on outside knowledge.
- It is not a duplicate or near-duplicate.
- Its source/page reference is accurate when source references are provided.
- Its JSON structure is valid.

If any mandatory condition fails, the question MUST NOT receive PASS.

---

PART A — CONTENT VALIDATION

Validate EVERY question individually.

For every question check:

C01 — Source Support

Determine whether the information needed to answer the question is explicitly supported by the screenshots.

PASS:
The screenshot clearly provides the required information.

FAIL:
The question introduces information not supported by the screenshots.

REVIEW:
The screenshot may contain relevant information, but the evidence is unclear or unreadable.

---

C02 — Correct Answer Verification

Verify that the answer identified by the "answer" index is actually supported by the textbook screenshots.

PASS:
The selected answer is clearly correct.

FAIL:
The selected answer contradicts the textbook.

REVIEW:
The screenshot does not provide enough evidence to establish the answer.

---

C03 — Exactly One Defensible Answer

Determine whether exactly ONE option is reasonably defensible from the supplied source.

FAIL the question if:

- Two or more options could reasonably be correct.
- The wording permits multiple interpretations.
- The textbook itself supports multiple options.
- The question depends on an unstated assumption.

Do NOT assume the intended answer.

---

C04 — Option Quality

Check every option.

Ensure:

- Options are relevant to the question.
- Options are comparable in type/form.
- No option is accidentally obviously correct because of wording.
- No option contains unsupported information that creates ambiguity.
- No two options mean essentially the same thing.
- There is no duplicate option.

---

C05 — Question Wording

Check for:

- Ambiguity
- Grammar problems affecting meaning
- Missing context
- Vague references
- Double negatives
- Trick wording
- Unnecessary complexity
- Multiple possible interpretations

The question should be understandable by the intended student.

---

C06 — Explanation Verification

Verify the explanation against the screenshots.

PASS:
The explanation correctly explains why the answer is correct using source-supported information.

FAIL:
The explanation contains unsupported, incorrect, contradictory, or invented information.

REVIEW:
The explanation cannot be fully verified from the screenshots.

The explanation must not introduce additional facts merely because they are generally true.

---

C07 — Chapter Relevance

Check whether the question belongs to the supplied chapter.

FAIL questions that primarily test information outside the supplied chapter.

---

C08 — Source/Page Verification

If a "source" field exists, verify it against the supplied screenshots.

Check:

- Chapter reference
- Page number
- Section reference when supplied

Do not invent a page number.

If the source reference cannot be verified, mark REVIEW.

---

C09 — Difficulty

Check whether the stated difficulty is reasonable.

Allowed values:

- easy
- medium
- hard

Difficulty should reflect the reasoning required from the supplied material, not the amount of text in the question.

Do not fail a question solely because reasonable educators could disagree slightly about difficulty. Mark REVIEW when genuinely questionable.

---

C10 — Duplicate Detection

Compare every question against every other question.

Identify:

- Exact duplicates
- Near duplicates
- Same question with reordered options
- Same concept tested with essentially identical wording
- Questions whose answers are effectively identical

Report duplicate groups together.

---

PART B — TECHNICAL VALIDATION

Validate the complete JSON.

T01 — JSON Validity

The question bank must be valid JSON.

FAIL if:

- JSON cannot be parsed.
- Missing commas/brackets/quotes.
- Invalid JSON syntax.

---

T02 — Required Top-Level Fields

Check required fields:

- version
- book
- chapter
- questions

Report missing fields.

---

T03 — Question Object Structure

Every question must contain:

- id
- question
- options
- answer
- explanation

Optional fields may include:

- difficulty
- topic
- source

---

T04 — Question ID

Check that:

- Every question has an ID.
- IDs are unique.
- IDs are non-empty.
- IDs are suitable for stable identification.

Duplicate IDs = FAIL.

---

T05 — Options

Check that:

- Options exist.
- There are at least 2 options.
- Options are non-empty.
- Options are strings.
- No duplicate options exist.

---

T06 — Answer Index

The "answer" value MUST be an integer.

It must point to an existing option.

Example:

4 options:

0 = Option 1
1 = Option 2
2 = Option 3
3 = Option 4

Invalid answer index = FAIL.

---

T07 — Explanation

Check that:

- Explanation exists.
- Explanation is non-empty.
- Explanation corresponds to the selected answer.

---

T08 — Difficulty

If present, difficulty must be one of:

- easy
- medium
- hard

Any other value = FAIL.

---

T09 — String Quality

Identify:

- Empty strings
- Excessive whitespace
- Broken encoding
- Obvious malformed text
- Placeholder text such as "TBD", "TODO", "Answer here"

These are FAIL conditions unless clearly intentional and valid.

---

T10 — Question Count

Report:

- Total questions
- Minimum requested questions, if specified
- Maximum requested questions, if specified
- Whether the question count requirement is satisfied

Do not invent a required count if none was supplied.

---

PART C — CROSS-QUESTION QUALITY

After individual validation, evaluate the bank as a whole.

Check:

Coverage

Does the bank cover the important concepts represented in the supplied screenshots?

Concentration

Is the bank excessively concentrated on one small section or concept?

Variety

Where the source permits it, identify whether questions include a reasonable mixture of:

- Recall
- Understanding
- Application
- Comparison
- Reasoning

Do NOT require question types that the textbook material does not support.

Redundancy

Identify excessive repetition.

Answer Distribution

Report the distribution of correct-answer positions.

Example:

A / position 0: 13
B / position 1: 12
C / position 2: 14
D / position 3: 11

Do NOT artificially rewrite questions solely to make the distribution equal.

Only report the distribution unless there is an obvious answer-position pattern that could reduce quiz quality.

---

PART D — SEVERITY CLASSIFICATION

Every problem must receive one severity:

CRITICAL

The question cannot safely be published.

Examples:

- Unsupported fact
- Incorrect answer
- Multiple defensible answers
- Invalid JSON
- Invalid answer index
- Duplicate question ID

MAJOR

Significant quality problem requiring correction.

Examples:

- Ambiguous wording
- Incorrect explanation
- Incorrect source reference
- Duplicate/near-duplicate question
- Question outside chapter

MINOR

Quality issue that does not necessarily invalidate the question.

Examples:

- Slight wording improvement
- Weak explanation
- Question difficulty questionable
- Minor formatting issue

REVIEW

Evidence is insufficient to confidently determine whether the question passes.

Never convert REVIEW into PASS by guessing.

---

PART E — QUESTION STATUS

For every question assign exactly one:

PASS

All mandatory checks pass.

FAIL

A definite quality or technical problem exists.

REVIEW

There is insufficient evidence to confidently pass or fail.

Use this exact logic:

IF definite problem exists → FAIL

ELSE IF evidence is insufficient → REVIEW

ELSE → PASS

---

PART F — QUESTION-LEVEL REPORT

Produce a table containing:

ID| Status| Severity| Source Support| Answer| Unique Answer| Wording| Explanation| Source| Duplicate| Problem

For each failed/review question, provide a concise explanation.

Include the specific evidence from the screenshot whenever possible.

Do not fabricate page numbers or quotations.

---

PART G — TECHNICAL VALIDATION REPORT

Produce:

Check| Status| Details
Valid JSON| PASS/FAIL| ...
Required fields| PASS/FAIL| ...
Unique IDs| PASS/FAIL| ...
Options| PASS/FAIL| ...
Answer indexes| PASS/FAIL| ...
Explanations| PASS/FAIL| ...
Difficulty values| PASS/FAIL| ...
Placeholder text| PASS/FAIL| ...
Question count| PASS/FAIL/N/A| ...

---

PART H — SUMMARY

Calculate:

- Total questions
- PASS count
- FAIL count
- REVIEW count
- Critical issue count
- Major issue count
- Minor issue count
- Duplicate count
- Unsupported-question count
- Ambiguous-question count
- Technical-error count

Calculate percentages where useful.

---

PART I — FINAL QUALITY GATE

The bank is:

READY FOR PUBLICATION

ONLY IF:

- JSON is technically valid.
- There are zero CRITICAL issues.
- There are zero MAJOR issues.
- There are zero FAIL questions.
- There are zero REVIEW questions.
- There are no duplicate IDs.
- There are no duplicate/near-duplicate questions requiring correction.
- Every answer is source-supported.
- Every question has exactly one defensible answer.
- Every explanation is source-supported.
- Required technical fields are valid.

Otherwise:

NOT READY FOR PUBLICATION

Do not soften this decision.

Do not say "mostly ready".

Do not approve a bank containing unresolved FAIL or REVIEW questions.

---

PART J — RELEASE SUMMARY

End the report with exactly this structure:

QUESTION BANK QUALITY GATE

Book: <book>
Chapter: <chapter>

Total Questions: <number>

CONTENT VALIDATION

Source Supported: <x>/<total>
Correct Answers Verified: <x>/<total>
Unique Defensible Answers: <x>/<total>
Clear Wording: <x>/<total>
Explanations Verified: <x>/<total>
Source References Verified: <x>/<total>
Duplicates: <number>

TECHNICAL VALIDATION

Valid JSON: PASS/FAIL
Required Fields: PASS/FAIL
Unique IDs: PASS/FAIL
Valid Options: PASS/FAIL
Valid Answer Indexes: PASS/FAIL
Valid Explanations: PASS/FAIL
Valid Difficulty Values: PASS/FAIL

RESULT

PASS: <number>
FAIL: <number>
REVIEW: <number>

CRITICAL: <number>
MAJOR: <number>
MINOR: <number>

FINAL STATUS: READY FOR PUBLICATION / NOT READY

BLOCKING ISSUES

<List every unresolved critical, major, and review issue>

RECOMMENDED ACTION

<Specific action required before publication>

---

IMPORTANT BEHAVIOR RULES

1. Never invent textbook evidence.
2. Never use outside knowledge to resolve uncertainty.
3. Never silently rewrite a question.
4. Never silently change an answer.
5. Never silently change an explanation.
6. Never mark an ambiguous question as PASS.
7. Never mark an unsupported question as PASS.
8. Never assume the intended answer.
9. Never invent source/page references.
10. Preserve the original question IDs.
11. Report every failure.
12. Review the entire question bank, not just a sample.
13. Compare questions against one another for duplicates.
14. Treat the supplied screenshots as the authoritative factual source.
15. If screenshots are unreadable or incomplete, mark the affected questions REVIEW.
16. If the JSON cannot be parsed, perform whatever content inspection is possible but mark technical validation FAIL.
17. Do not produce a "corrected" question bank unless explicitly requested.
18. The primary output is the QUALITY GATE REPORT.
19. The final status must be either READY FOR PUBLICATION or NOT READY.
20. A question bank with unresolved uncertainty is NOT READY.

OPTIONAL CORRECTED OUTPUT

ONLY if the user explicitly asks:

"Generate corrected JSON"

then produce corrected JSON after the quality report.

Corrections must be limited to issues identified by the quality gate.

Do not introduce information that is absent from the screenshots.

If a question cannot be safely corrected using the screenshots, retain it as REVIEW rather than inventing content.

FINAL INSTRUCTION

Perform the complete quality gate on EVERY supplied question.

Do not skip questions.

Do not sample.

Do not guess.

Return the complete quality report followed by the final publication status.`;

self.addEventListener("message", async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "initialize") {
      await initializeModel();
      self.postMessage({ type: "ready", device: runtimeDevice });
      return;
    }
    if (msg.type === "compatibility-test") {
      await runCompatibilityTest(msg.requestId);
      return;
    }
    if (msg.type === "generate") await runPipeline(msg.payload);
  } catch (error) {
    console.error(error);
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
});

async function runCompatibilityTest(requestId) {
  try {
    sendProgress(28, "Compatibility test", "Initializing the same local LLM used by the application…");
    await initializeModel();
    sendProgress(55, "Compatibility test", `Running a short real inference on ${runtimeDevice}…`);
    const result = await generator([
      { role: "system", content: "Reply with exactly the word READY." },
      { role: "user", content: "Compatibility test." }
    ], {
      max_new_tokens: 8,
      temperature: 0,
      do_sample: false,
      return_full_text: false
    });
    const generated = result?.[0]?.generated_text;
    let text = "";
    if (Array.isArray(generated)) text = generated[generated.length - 1]?.content || "";
    else text = typeof generated === "string" ? generated : String(generated || "");
    const ok = text.trim().length > 0;
    self.postMessage({
      type: ok ? "compatibility-result" : "compatibility-error",
      requestId,
      ok,
      device: runtimeDevice,
      detail: ok ? `Real model inference succeeded (${runtimeDevice}). Output received from the local model.` : "The model initialized but returned no generated text."
    });
    sendProgress(60, "Compatibility test complete", ok ? `Local AI inference passed on ${runtimeDevice}.` : "Local AI inference returned no output.");
  } catch (error) {
    self.postMessage({ type: "compatibility-error", requestId, message: error?.message || String(error) });
  }
}

async function initializeModel() {
  if (generator) return;

  sendProgress(27, "Loading AI model", "Checking WebGPU availability…");
  const hasWebGPU = typeof navigator !== "undefined" && !!navigator.gpu;

  if (hasWebGPU) {
    try {
      sendProgress(30, "Loading AI model", "Attempting WebGPU acceleration…");
      generator = await pipeline("text-generation", MODEL_ID, {
        device: "webgpu",
        dtype: "q4f16",
        progress_callback: handleModelProgress
      });
      runtimeDevice = "WebGPU";
      sendProgress(50, "AI model ready", "Llama 3.2 1B is running with WebGPU.");
      return;
    } catch (error) {
      console.warn("WebGPU failed; falling back to WASM.", error);
      generator = null;
    }
  }

  try {
    sendProgress(42, "Loading AI model", "Falling back to WASM…");
    generator = await pipeline("text-generation", MODEL_ID, {
      device: "wasm",
      dtype: "q4",
      progress_callback: handleModelProgress
    });
    runtimeDevice = "WASM";
    sendProgress(50, "AI model ready", "Llama 3.2 1B is running with WASM.");
  } catch (error) {
    throw new Error(formatModelLoadError(error));
  }
}

function formatModelLoadError(error) {
  const raw = error?.stack || error?.message || String(error);
  const normalized = raw.toLowerCase();
  const hints = [];
  if (normalized.includes("failed to fetch") || normalized.includes("network")) {
    hints.push("A browser/network asset could not be fetched. Check that Hugging Face and jsDelivr are reachable and disable restrictive content blockers for this site.");
    hints.push("If the WebGPU check passes but AI loading fails, inspect the browser Console/Network tab for the blocked URL.");
  }
  if (normalized.includes("out of memory") || normalized.includes("memory")) {
    hints.push("The device may not have enough available RAM/GPU memory for the local model.");
  }
  return `Local LLM initialization failed. ${hints.join(" ")} Original error: ${raw}`;
}

function handleModelProgress(progress) {
  if (typeof progress?.progress !== "number") return;
  const p = Math.round(30 + progress.progress * 20 / 100);
  sendProgress(p, "Downloading AI model", progress.file ? `${progress.file} • ${Math.round(progress.progress)}%` : "Downloading model files…");
}

async function runPipeline(payload) {
  const sourceText = String(payload?.sourceText || "");
  const sourceDiagnostics = payload?.sourceDiagnostics || null;
  const book = String(payload?.book || "Science");
  const chapter = String(payload?.chapter || "Chapter 1");
  const requestedCount = Math.max(1, Math.min(100, Number(payload?.requestedCount || 20)));

  if (!sourceText.trim()) throw new Error("No PDF/OCR source text was supplied.");

  await initializeModel();

  const sourceForModel = limitSourceLength(sourceText, 90000);

  sendProgress(52, "Step 1 of 2", `Generating ${requestedCount} questions from the local source…`);

  const generationUserMessage = `
BOOK:
${book}

CHAPTER:
${chapter}

REQUESTED QUESTION COUNT:
${requestedCount}

IMPORTANT SOURCE INTERPRETATION:

This application uses a local PDF source pipeline.

For every page, PDF.js selectable text is used when sufficient text is available. Text-poor pages are rendered locally and processed with local Tesseract.js OCR. The page records below are therefore the authoritative source document supplied to this model.

Treat ONLY this source document as authoritative.

SOURCE EXTRACTION DIAGNOSTICS:
${JSON.stringify(sourceDiagnostics || {}, null, 2)}

TEXTBOOK SOURCE
================
${sourceForModel}
================
END TEXTBOOK SOURCE

Generate exactly ${requestedCount} questions.

Follow the generation instructions above.

For machine processing, finish your response with:

<QUESTION_BANK_JSON>
{
  "version": 1,
  "book": "${escapeForPrompt(book)}",
  "chapter": "${escapeForPrompt(chapter)}",
  "questions": []
}
</QUESTION_BANK_JSON>

The JSON inside QUESTION_BANK_JSON must be valid JSON.
Do not put Markdown fences around it.`;

  const generationOutput = await generateText(
    [
      { role: "system", content: GENERATION_PROMPT },
      { role: "user", content: generationUserMessage }
    ],
    { max_new_tokens: calculateGenerationTokens(requestedCount) }
  );

  const questionBank = extractQuestionBank(generationOutput);
  if (!questionBank || !Array.isArray(questionBank.questions)) {
    throw new Error("Step 1 completed, but the model did not return valid QUESTION_BANK_JSON.");
  }

  sendProgress(68, "Step 1 complete", `${questionBank.questions.length} generated questions received.`);

  sendProgress(70, "Step 2 of 2", "Running the complete Question Bank Quality Gate…");

  const validationUserMessage = `
BOOK:
${book}

CHAPTER:
${chapter}

REQUESTED QUESTION COUNT:
${requestedCount}

SOURCE EXTRACTION DIAGNOSTICS:
${JSON.stringify(sourceDiagnostics || {}, null, 2)}

TEXTBOOK SOURCE
================
${sourceForModel}
================
END TEXTBOOK SOURCE

GENERATED QUESTION BANK
=======================
${JSON.stringify(questionBank, null, 2)}
=======================
END GENERATED QUESTION BANK

IMPORTANT EXECUTION RULE:

The source supplied above is the authoritative textbook source.

For this browser implementation, the source is a locally extracted PDF/OCR document. OCR text can contain recognition errors. Do not silently "fix" OCR using outside knowledge. If the source evidence is unclear, mark the affected question REVIEW.

Do not use Internet knowledge, general knowledge, prior knowledge, training knowledge, assumptions, or unstated textbook information.

Validate EVERY question.
Do not sample.
Do not skip questions.
Do not correct questions.
Do not change answers.
Do not change explanations.

Return the complete quality report required by the Quality Gate.

For machine extraction, place the complete report between:

<QUALITY_GATE_REPORT>
...
</QUALITY_GATE_REPORT>

Do not place the report inside Markdown code fences.`;

  const validationOutput = await generateText(
    [
      { role: "system", content: VALIDATION_PROMPT },
      { role: "user", content: validationUserMessage }
    ],
    { max_new_tokens: calculateValidationTokens(questionBank.questions.length) }
  );

  const validationReport = extractValidationReport(validationOutput);

  sendProgress(98, "Quality Gate complete", "Preparing the final question and validation view…");

  self.postMessage({
    type: "result",
    result: {
      questionBank,
      validationReport,
      runtimeDevice,
      model: MODEL_ID,
      transformersVersion: TRANSFORMERS_VERSION,
      sourceDiagnostics
    }
  });
}

async function generateText(messages, options = {}) {
  if (!generator) await initializeModel();
  const result = await generator(messages, {
    max_new_tokens: options.max_new_tokens || 1024,
    temperature: 0.15,
    do_sample: true,
    return_full_text: false
  });

  const generated = result?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return last?.content || "";
  }
  return typeof generated === "string" ? generated : String(generated || "");
}

function extractQuestionBank(text) {
  if (!text) return null;

  const start = text.indexOf("<QUESTION_BANK_JSON>");
  const end = text.indexOf("</QUESTION_BANK_JSON>");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start + "<QUESTION_BANK_JSON>".length, end).trim();
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed;
  }

  for (const candidate of extractJsonObjects(text)) {
    if (candidate && Array.isArray(candidate.questions)) return candidate;
  }
  return null;
}

function extractValidationReport(text) {
  if (!text) return "No validation report returned.";
  const start = text.indexOf("<QUALITY_GATE_REPORT>");
  const end = text.indexOf("</QUALITY_GATE_REPORT>");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start + "<QUALITY_GATE_REPORT>".length, end).trim();
  }
  return text.trim();
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractJsonObjects(text) {
  const results = [];
  let depth = 0, start = -1, inString = false, escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const parsed = tryParseJson(text.slice(start, i + 1));
        if (parsed) results.push(parsed);
        start = -1;
      }
    }
  }
  return results;
}

function escapeForPrompt(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

function limitSourceLength(text, maximumCharacters) {
  if (text.length <= maximumCharacters) return text;
  const half = Math.floor(maximumCharacters / 2);
  return text.slice(0, half) +
    "\n\n===== SOURCE TRUNCATED BY BROWSER RUNTIME =====\n\n" +
    text.slice(-half);
}

function calculateGenerationTokens(count) {
  return Math.min(9000, Math.max(1800, 700 + count * 170));
}

function calculateValidationTokens(count) {
  return Math.min(10000, Math.max(2500, 1200 + count * 170));
}

function sendProgress(percent, title, message) {
  self.postMessage({ type: "progress", percent, title, message });
}
