let input = "";

process.stdin.on("data", (d) => {
  input += d;
});

process.stdin.on("end", () => {
  process.stdout.write(input)
  process.exit(0);
});
