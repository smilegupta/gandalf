"use strict";

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

process.stdin.on("end", () => {
  // Normalize line endings: CRLF/CR -> LF
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Empty diff -> error + exit 0
  if (input.trim().length === 0) {
    process.stderr.write("GitGandalf: empty diff - nothing to review.\n");
    process.exit(0);
  }

  // Size cap -> reject
  const size = Buffer.byteLength(input, "utf8");
  if (size > MAX_DIFF_BYTES) {
    process.stderr.write(
      `GitGandalf: diff too large (${size} bytes). Max allowed is ${MAX_DIFF_BYTES} bytes. Please split the change.\n`
    );
    process.exit(1);
  }

  process.stdout.write(input);
  process.exit(0);
});

process.stdin.resume();
