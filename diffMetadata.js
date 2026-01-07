"use strict";

function extractDiffMetadata(diffText) {
  const out = {
    files_changed: 0,
    files: [],
    lines_added: 0,
    lines_removed: 0,
  };

  if (typeof diffText !== "string" || diffText.length === 0) {
    return out;
  }

  const lines = diffText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  let aPath = null;
  let bPath = null;
  let renameTo = null;
  let isBinary = false;

  const seen = new Set();

  const clean = (p) => (p || "").replace(/^a\//, "").replace(/^b\//, "");
  const isDevNull = (p) => p === "/dev/null";

  const finalize = () => {
    if (!aPath && !bPath && !renameTo) {
      return;
    }

    if (!isBinary) {
      let file;
      if (renameTo) {
        file = clean(renameTo);
      } else if (isDevNull(bPath)) {
        file = clean(aPath);
      } // deleted
      else {
        file = clean(bPath);
      } // added/modified

      if (file && !seen.has(file)) {
        seen.add(file);
        out.files.push(file);
      }
    }

    // reset for next file
    aPath = null;
    bPath = null;
    renameTo = null;
    isBinary = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finalize();

      const parts = line.split(" ");
      aPath = parts[2] || "";
      bPath = parts[3] || "";
      continue;
    }

    if (!aPath && !bPath) {
      continue;
    } // not inside a file diff yet

    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      isBinary = true;
      continue;
    }

    if (line.startsWith("rename to ")) {
      renameTo = line.slice("rename to ".length).trim();
      continue;
    }

    // Count hunk lines (ignore file header lines +++/---)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.lines_added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      out.lines_removed += 1;
    }
  }

  finalize();

  out.files_changed = out.files.length;
  return out;
}

module.exports = { extractDiffMetadata };
