"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { extractDiffMetadata } = require("./diffMetadata");
const { buildJudgePromptV1 } = require("./judgePrompt.v1");

const MAX_DIFF_BYTES = 50_000;
const REVIEW_FILE = ".gandalf-review.json";
const CONFIG_FILE = ".gandalfrc.json";

// Load config
function loadConfig() {
  try {
    const configPath = path.resolve(process.cwd(), CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (e) {
    // ignore config errors, use defaults
  }
  return { skipPatterns: [] };
}

// Check if filename matches a glob pattern (simple glob: *.ext)
function matchesPattern(filename, pattern) {
  if (pattern.startsWith("*.")) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern || filename.endsWith("/" + pattern);
}

// Check if all files should be skipped
function shouldSkipReview(files, skipPatterns) {
  if (!files.length || !skipPatterns.length) return false;
  return files.every((file) =>
    skipPatterns.some((pattern) => matchesPattern(file, pattern))
  );
}

// Detect interactive terminal vs CI
const isTTY = process.stderr.isTTY;

// Spinner with rotating messages
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_MESSAGES = [
  "🧙 Gandalf is reviewing your code...",
  "🔍 Analyzing diff for issues...",
  "📝 Checking for security concerns...",
  "🧠 Deep in thought...",
  "✨ Consulting the ancient scrolls...",
];

function createSpinner() {
  if (!isTTY) return { stop: () => {} };

  let frameIdx = 0;
  let msgIdx = 0;
  let elapsed = 0;

  const interval = setInterval(() => {
    const frame = SPINNER_FRAMES[frameIdx];
    const msg = THINKING_MESSAGES[msgIdx];
    process.stderr.write(`\r\x1b[K${frame} ${msg} (${elapsed}s)`);

    frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
    elapsed++;

    // Rotate message every 5 seconds
    if (elapsed % 5 === 0) {
      msgIdx = (msgIdx + 1) % THINKING_MESSAGES.length;
    }
  }, 1000);

  process.stderr.write(`${SPINNER_FRAMES[0]} ${THINKING_MESSAGES[0]}`);

  return {
    stop: (msg) => {
      clearInterval(interval);
      process.stderr.write(`\r\x1b[K${msg}\n`);
    },
  };
}

function log(msg) {
  process.stderr.write(msg + "\n");
}

// Get commit message from args (passed by pre-commit hook)
const commitMessage = process.argv[2] || "";

let input = "";

process.stdin.on("error", (err) => {
  log(`error: failed to read diff - ${err.message}`);
  process.exit(1);
});

process.stdin.on("data", (chunk) => (input += chunk));

process.stdin.on("end", async () => {
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!input.trim()) {
    log("nothing to review");
    process.exit(0);
  }

  const size = Buffer.byteLength(input, "utf8");
  if (size > MAX_DIFF_BYTES) {
    log(`diff too large (${size}b > ${MAX_DIFF_BYTES}b) - split your commit`);
    process.exit(1);
  }

  const metadata = extractDiffMetadata(input);
  const config = loadConfig();

  // Smart skip: if all files match skip patterns, skip review
  if (shouldSkipReview(metadata.files || [], config.skipPatterns || [])) {
    log("🔇 Skipped - docs/config only. Ship it!");
    process.exit(0);
  }

  const prompt = buildJudgePromptV1({
    metadataJson: JSON.stringify(metadata, null, 2),
    diffText: input,
    commitMessage: commitMessage,
  });

  const spinner = createSpinner();

  try {
    const raw = await runLocalLLM(prompt);
    const json = extractJson(raw);
    const review = validate(JSON.parse(json));

    // Save full review
    const output = {
      timestamp: new Date().toISOString(),
      files: metadata.files || [],
      review,
    };
    fs.writeFileSync(
      path.resolve(process.cwd(), REVIEW_FILE),
      JSON.stringify(output, null, 2) + "\n"
    );

    spinner.stop(`🧙 Gandalf reviewed your code → ${REVIEW_FILE}`);

    // Show message review feedback if any
    if (review.messageReview && review.messageReview.trim()) {
      log(`💬 ${review.messageReview}`);
    }

    if (review.risk === "LOW") {
      log("✅ Ship it!");
    } else if (review.risk === "MEDIUM") {
      log("⚠️  Ok, but check the review.");
    } else {
      log("🚨 You shall not pass! Fix the issues first.");
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    spinner.stop("✗ failed");
    log(err.message);
    process.exit(1);
  }
});

process.stdin.resume();

function runLocalLLM(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["localLlmRunner.js"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => reject(new Error(`spawn failed: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      resolve(out.trimEnd());
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(text) {
  let s = String(text || "");

  // Strip <think>...</think> blocks
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Strip markdown code fences
  s = s.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  // Find balanced JSON object (handles nested braces, ignores braces in strings)
  const start = s.indexOf("{");
  if (start === -1) throw new Error("no JSON found");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (c === "{") depth++;
    else if (c === "}") depth--;

    if (depth === 0) return s.slice(start, i + 1);
  }

  throw new Error("malformed JSON");
}

function validate(obj) {
  const required = ["risk", "issues", "summary"];

  for (const k of required) {
    if (!(k in obj)) throw new Error(`missing: ${k}`);
  }

  if (!["LOW", "MEDIUM", "HIGH"].includes(obj.risk)) {
    throw new Error("invalid risk");
  }
  if (!Array.isArray(obj.issues)) {
    throw new Error("issues must be array");
  }
  if (typeof obj.summary !== "string") {
    throw new Error("summary must be string");
  }

  return {
    risk: obj.risk,
    issues: obj.issues,
    summary: obj.summary,
    messageReview: obj.messageReview || "",
  };
}
