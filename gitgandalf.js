let input = "";

process.stdin.on("data", (d) => {
  input += d;
});

process.stdin.on("end", () => {
  if (input.length > 0) {
    process.stdout.write(input);
    process.exit(1);
  }

  process.exit(0);
});
