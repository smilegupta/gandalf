// configs
const BASE_URL = "http://127.0.0.1:1234/v1";
const MODEL = "qwen/qwen3-4b-thinking-2507";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes 

// exit codes for the script
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_WARN_TIMEOUT = 2;

// data stream decoding
process.stdin.setEncoding("utf8");

let input = "";

// Read from STDIN
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `LocalLlmRunner: failed to read input from STDIN - ${msg}\n`
  );
  process.exit(EXIT_FAIL);
});

process.stdin.on("end", async () => {
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (input.trim().length === 0) {
    process.stderr.write("LocalLlmRunner: empty input - nothing to run.\n");
    process.exit(EXIT_OK);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: input }],
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LocalLlmRunner: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`
      );
    }

    const data = await res.json();
    const output = data?.choices?.[0]?.message?.content;

    if (typeof output !== "string") {
      throw new Error("LocalLlmRunner: unexpected response format");
    }

    process.stdout.write(output);

    if (!output.endsWith("\n")) {
      process.stdout.write("\n");
    }
    process.exit(EXIT_OK);
  } catch (err) {
    if (err.name === "AbortError") {
      process.stderr.write("LocalLlmRunner: request timed out.\n");
      process.exit(EXIT_WARN_TIMEOUT);
    } else {
      process.stderr.write(`${err.message}\n`);
      process.exit(EXIT_FAIL);
    }
  } finally {
    clearTimeout(timeoutId);
  }
});

process.stdin.resume();
