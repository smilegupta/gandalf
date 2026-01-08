"use strict";

const { spawn } = require("child_process");
const { extractDiffMetadata } = require("./diffMetadata");

const MAX_DIFF_BYTES = 50_000;

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

  const prompt = [
    "You are a senior engineer reviewing a git diff.",
    "",
    "Return a short review.",
    "If the change should be blocked, include the word: BLOCK",
    "Otherwise include the word: APPROVE",
    "",
    "Metadata (FYI):",
    JSON.stringify(metadata, null, 2),
    "",
    "Diff:",
    input,
    "",
  ].join("\n");

  try {
    const reviewText = await runLocalLLM(prompt);

    if (reviewText.includes("BLOCK")) {
      process.stderr.write("GitGandalf: commit blocked by LLM review.\n\n");
      process.stderr.write(reviewText + "\n");
      process.exit(1);
      return;
    }

    process.stdout.write(reviewText + "\n");
    process.exit(0);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`GitGandalf: LLM review failed - ${msg}\n`);
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
