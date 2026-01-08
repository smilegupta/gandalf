"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { extractDiffMetadata } = require("./diffMetadata");
const { buildJudgePromptV1 } = require("./judgePrompt.v1");

const MAX_DIFF_BYTES = 50_000;
const REVIEW_OUTPUT_FILE = ".gandalf-review.json";

// Spinner for visual feedback while thinking
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_MESSAGES = [
  "🧙 Gandalf is reviewing your code...",
  "🔍 Analyzing diff for issues...",
  "📝 Checking for security concerns...",
  "🧠 Deep in thought...",
  "✨ Consulting the ancient scrolls...",
];

function createSpinner(message) {
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

  // Show initial message immediately
  process.stderr.write(`${SPINNER_FRAMES[0]} ${message}`);

  return {
    stop: (finalMessage) => {
      clearInterval(interval);
      process.stderr.write(`\r\x1b[K${finalMessage}\n`);
    },
  };
}

let input = "";

// Fail closed on stream errors
process.stdin.on("error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GitGandalf: failed to read diff from STDIN - ${msg}\n`);
  process.exit(1);
});

process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", async () => {
  // Normalize line endings: CRLF/CR -> LF
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Empty diff -> error + exit 0
  if (input.trim().length === 0) {
    process.stderr.write("GitGandalf: empty diff - nothing to review.\n");
    process.exit(0);
    return;
  }

  // Size cap -> reject
  const size = Buffer.byteLength(input, "utf8");
  if (size > MAX_DIFF_BYTES) {
    process.stderr.write(
      `GitGandalf: diff too large (${size} bytes). Max allowed is ${MAX_DIFF_BYTES} bytes. Please split the change.\n`
    );
    process.exit(1);
    return;
  }

  const metadata = extractDiffMetadata(input);

  const prompt = buildJudgePromptV1({
    metadataJson: JSON.stringify(metadata, null, 2),
    diffText: input,
  });

  const spinner = createSpinner(THINKING_MESSAGES[0]);

  try {
    const judgeRaw = await runLocalLLM(prompt);

    const jsonText = extractFirstJsonObject(judgeRaw);
    const judgeObj = JSON.parse(jsonText);
    const validated = validateJudgeSchema(judgeObj);

    // Build review output with timestamp
    const reviewOutput = {
      timestamp: new Date().toISOString(),
      files: metadata.files || [],
      review: validated,
    };

    // Save to file
    const outputPath = path.resolve(process.cwd(), REVIEW_OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(reviewOutput, null, 2) + "\n");

    // Stop spinner with success
    const riskEmoji = { LOW: "✅", MEDIUM: "⚠️", HIGH: "🚨" }[validated.risk];
    spinner.stop(`${riskEmoji} Review complete! Risk: ${validated.risk}`);

    // Pretty print the review
    process.stderr.write("\n");
    process.stderr.write("┌─────────────────────────────────────────┐\n");
    process.stderr.write("│          🧙 GANDALF'S VERDICT           │\n");
    process.stderr.write("└─────────────────────────────────────────┘\n");
    process.stderr.write(`\n📊 Risk Level: ${riskEmoji} ${validated.risk}\n`);
    process.stderr.write(`\n📝 Summary:\n   ${validated.summary}\n`);

    if (validated.issues.length > 0) {
      process.stderr.write(`\n⚠️  Issues Found:\n`);
      validated.issues.forEach((issue, i) => {
        process.stderr.write(`   ${i + 1}. ${issue}\n`);
      });
    } else {
      process.stderr.write(`\n✨ No issues found!\n`);
    }

    process.stderr.write(
      `\n📁 Full review saved to: ${REVIEW_OUTPUT_FILE}\n\n`
    );

    // Also write JSON to stdout for piping
    process.stdout.write(JSON.stringify(validated, null, 2) + "\n");
    process.exit(0);
    return;
  } catch (err) {
    spinner.stop("❌ Review failed!");
    process.stderr.write(`GitGandalf: judge output invalid - ${err.message}\n`);
    process.exit(1);
    return;
  }
});

process.stdin.resume();

function runLocalLLM(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["localLlmRunner.js"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let error = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start local LLM: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        // include stderr to debug model/server issues
        return reject(
          new Error(`Local LLM exited with code ${code}. ${error.trim()}`)
        );
      }
      resolve(output.trimEnd());
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractFirstJsonObject(text) {
  let content = String(text || "");

  // Strip thinking model output: <think>...</think> blocks
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Find the first JSON object by matching balanced braces
  const startIdx = content.indexOf("{");
  if (startIdx === -1) {
    throw new Error("No JSON object found in output");
  }

  let braceCount = 0;
  let endIdx = -1;

  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === "{") braceCount++;
    else if (content[i] === "}") braceCount--;

    if (braceCount === 0) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    throw new Error("Malformed JSON object - unbalanced braces");
  }

  return content.slice(startIdx, endIdx + 1);
}

function validateJudgeSchema(obj) {
  const allowedKeys = ["risk", "issues", "summary"];
  const keys = Object.keys(obj);

  // no missing, no extra
  if (keys.length !== allowedKeys.length) {
    throw new Error("Judge output must contain exactly 3 fields");
  }
  for (const k of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      throw new Error(`Missing required field: ${k}`);
    }
  }
  for (const k of keys) {
    if (!allowedKeys.includes(k)) {
      throw new Error(`Unexpected field: ${k}`);
    }
  }

  // risk enum
  if (!["LOW", "MEDIUM", "HIGH"].includes(obj.risk)) {
    throw new Error("Invalid risk value");
  }

  // issues array of strings
  if (
    !Array.isArray(obj.issues) ||
    obj.issues.some((x) => typeof x !== "string")
  ) {
    throw new Error("issues must be an array of strings");
  }

  // summary string
  if (typeof obj.summary !== "string") {
    throw new Error("summary must be a string");
  }

  return obj;
}
