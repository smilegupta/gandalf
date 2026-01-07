const MIN_DIFF_BYTES = 1;
const MAX_DIFF_BYTES = 50_000;

let input = "";

process.stdin.on("data", (d) => {
  input += d;
});

process.stdin.on("end", () => {
  const size = Buffer.byteLength(input, "utf8");

  if (size < MIN_DIFF_BYTES) {
    console.error("GitGandalf: empty diff");
    process.exit(0);
  }

  if (size > MAX_DIFF_BYTES) {
    console.error(
      `GitGandalf: diff too large (${size} bytes). Please split the change.`
    );
    process.exit(1);
  }

  process.stdout.write(input);
  process.exit(0);
});

process.stdin.resume();
