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
const isInteractive = isTTY && !process.env.CI;

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

// Classify errors into user-friendly messages
function classifyError(err) {
  const msg = (err.message || "").toLowerCase();

  if (msg.includes("econnrefused") || msg.includes("fetch failed")) {
    return {
      type: "connection",
      icon: "🔌",
      title: "LLM server not running",
      hint: "Start LM Studio at http://127.0.0.1:1234",
    };
  }

  if (msg.includes("timeout") || msg.includes("abort")) {
    return {
      type: "timeout",
      icon: "⏱️",
      title: "LLM request timed out",
      hint: "Model may be overloaded, try again",
    };
  }

  if (msg.includes("no json") || msg.includes("malformed json")) {
    return {
      type: "parse",
      icon: "📄",
      title: "LLM returned invalid format",
      hint: "Model didn't follow output contract",
    };
  }

  if (msg.includes("invalid risk") || msg.includes("missing:")) {
    return {
      type: "schema",
      icon: "📋",
      title: "LLM response missing required fields",
      hint: "Try a different model or retry",
    };
  }

  if (msg.includes("spawn failed") || msg.includes("enoent")) {
    return {
      type: "spawn",
      icon: "⚙️",
      title: "Failed to run LLM script",
      hint: "Check localLlmRunner.js exists",
    };
  }

  return {
    type: "unknown",
    icon: "❓",
    title: "Unexpected error occurred",
    hint: `Details: ${err.message.slice(0, 40)}`,
  };
}

// Interactive prompt for user input
function askUser(question) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    // Re-open stdin for reading (it was closed after diff input)
    const tty = require("tty");
    if (tty.isatty(0)) {
      const fd = fs.openSync("/dev/tty", "r");
      const ttyStream = new tty.ReadStream(fd);
      rl.input = ttyStream;
      rl.question(question, (answer) => {
        ttyStream.close();
        rl.close();
        resolve(answer.trim().toLowerCase());
      });
    } else {
      rl.close();
      resolve("");
    }
  });
}

// Show interactive menu after review
async function showInteractiveMenu(review, reviewFile) {
  log("");
  log("┌─────────────────────────────────────┐");
  log("│  What would you like to do?         │");
  log("├─────────────────────────────────────┤");
  log("│  [p] Proceed with commit            │");
  log("│  [a] Abort commit                   │");
  log("│  [v] View full review               │");
  log("└─────────────────────────────────────┘");

  const answer = await askUser("\n> ");

  switch (answer) {
    case "p":
      log("✅ Proceeding with commit...");
      return true;

    case "v":
      log("");
      log("─── Full Review ───");
      log(`Risk: ${review.risk}`);
      log(`Summary: ${review.summary}`);
      if (review.issues.length > 0) {
        log("Issues:");
        review.issues.forEach((issue, i) => log(`  ${i + 1}. ${issue}`));
      } else {
        log("Issues: None");
      }
      if (review.messageReview) {
        log(`Message feedback: ${review.messageReview}`);
      }
      log("───────────────────");
      log("");
      // After viewing, ask again
      return showInteractiveMenu(review, reviewFile);

    case "a":
    default:
      log("🛑 Commit aborted.");
      return false;
  }
}

// Parse arguments
const args = process.argv.slice(2);
const messageOnlyMode = args[0] === "--message-only";
const commitMessage = messageOnlyMode ? args.slice(1).join(" ") : args[0] || "";

let input = "";

// Message-only mode: just review the commit message
if (messageOnlyMode) {
  (async () => {
    if (!commitMessage.trim()) {
      process.exit(0);
    }

    try {
      const msgPrompt = buildMessageReviewPrompt(commitMessage);
      const raw = await runLocalLLM(msgPrompt);
      const feedback = extractMessageFeedback(raw);

      if (feedback && feedback.trim()) {
        log(`💬 ${feedback}`);
      }
      process.exit(0);
    } catch (err) {
      // Don't block commit for message review failures
      process.exit(0);
    }
  })();
} else {
  // Normal mode: review diff (and optionally message)
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
        process.exit(0);
      } else if (review.risk === "MEDIUM") {
        log("⚠️  MEDIUM risk detected.");
        if (isInteractive) {
          const proceed = await showInteractiveMenu(review, REVIEW_FILE);
          process.exit(proceed ? 0 : 1);
        } else {
          log("⚠️  Ok, but check the review.");
          process.exit(0);
        }
      } else {
        log("🚨 HIGH risk detected!");
        if (isInteractive) {
          const proceed = await showInteractiveMenu(review, REVIEW_FILE);
          process.exit(proceed ? 0 : 1);
        } else {
          log("🚨 Blocked. Fix the issues first.");
          process.exit(1);
        }
      }

      process.exit(0);
    } catch (err) {
      spinner.stop("🧙 Gandalf couldn't complete the review");

      // Provide user-friendly error messages
      const errorType = classifyError(err);
      log("");
      log("┌─────────────────────────────────────────────────────┐");
      log("│  ⚠️  Review unavailable                             │");
      log("├─────────────────────────────────────────────────────┤");
      log(`│  ${errorType.icon} ${errorType.title.padEnd(43)}│`);
      log("├─────────────────────────────────────────────────────┤");
      log(`│  ${errorType.hint.padEnd(49)}│`);
      log("└─────────────────────────────────────────────────────┘");
      log("");

      // Save error to review file for debugging
      const errorOutput = {
        timestamp: new Date().toISOString(),
        files: metadata.files || [],
        error: {
          type: errorType.type,
          message: err.message,
          hint: errorType.hint,
        },
      };
      fs.writeFileSync(
        path.resolve(process.cwd(), REVIEW_FILE),
        JSON.stringify(errorOutput, null, 2) + "\n"
      );

      // Don't block commit on review failures - let it through with warning
      log("✅ Proceeding without review (check LLM server)");
      process.exit(0);
    }
  });

  process.stdin.resume();
}

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
    if (!(k in obj)) {
      throw new Error(`missing: ${k} (LLM didn't return required field)`);
    }
  }

  if (!["LOW", "MEDIUM", "HIGH"].includes(obj.risk)) {
    throw new Error(
      `invalid risk: got "${obj.risk}" (expected LOW, MEDIUM, or HIGH)`
    );
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

// Build prompt for message-only review
function buildMessageReviewPrompt(message) {
  return [
    "ROLE: You are reviewing a git commit message for quality.",
    "",
    "TASK: Analyze the commit message and provide brief feedback if needed.",
    "",
    "GOOD commit messages:",
    "- Descriptive, explains what and why",
    "- Uses conventional format (feat:, fix:, docs:, etc.)",
    "- Clear and specific",
    "",
    "BAD commit messages:",
    "- Vague (fix stuff, update, wip)",
    "- Too short with no context",
    "- Typos or unclear language",
    "",
    "OUTPUT:",
    "- If the message is good, respond with just: OK",
    "- If the message needs improvement, respond with a single brief suggestion (one sentence)",
    "- Do not use jokes or references",
    "",
    `COMMIT MESSAGE: "${message.trim()}"`,
  ].join("\n");
}

// Extract feedback from message review response
function extractMessageFeedback(raw) {
  const text = String(raw || "").trim();

  // Strip thinking tags
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // If response is just "OK" or similar, no feedback needed
  if (/^ok$/i.test(cleaned) || /^(good|lgtm|looks good)/i.test(cleaned)) {
    return "";
  }

  // Return the feedback (first line if multiline)
  const firstLine = cleaned.split("\n")[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}
