# 🧙 Git Gandalf

**Git Gandalf** is a local, LLM-powered **pre-commit code reviewer**.

It reads your **staged Git diff**, sends it to a **locally running LLM**, and decides whether your commit should be **allowed, warned, or blocked** - all before the commit is created.

- Runs locally
- No cloud calls
- No frameworks
- Uses a raw Git pre-commit hook + Node.js

> _"You Shall Not Commit" - when the risk is too high._

---

## Install

### Requirements

- **Node.js 24+** (check with `node -v`)
- **Local LLM server** running at `http://127.0.0.1:1234` (e.g., [LM Studio](https://lmstudio.ai/))
- A model loaded (default: `qwen/qwen3-4b-thinking-2507`)

### Setup

1. Clone/copy Gandalf files to your repo:

   ```
   gitgandalf.js
   localLlmRunner.js
   diffMetadata.js
   judgePrompt.v1.js
   ```

2. Create the Git hook:

   ```bash
   cat > .git/hooks/pre-commit << 'EOF'
   #!/bin/sh
   DIFF="$(git diff --cached)"
   if [ -z "$DIFF" ]; then
     exit 0
   fi
   COMMIT_MSG=""
   if [ -f ".git/COMMIT_EDITMSG" ]; then
     COMMIT_MSG="$(cat .git/COMMIT_EDITMSG)"
   fi
   echo "$DIFF" | node gitgandalf.js "$COMMIT_MSG"
   exit $?
   EOF
   ```

3. Make it executable:

   ```bash
   chmod +x .git/hooks/pre-commit
   ```

4. Done. Try a commit.

---

## Usage

Just commit as normal:

```bash
git add .
git commit -m "your message"
```

Gandalf will review and respond:

- `✅ Ship it!` → LOW risk, commit proceeds
- `⚠️  Ok, but check the review.` → MEDIUM risk, commit proceeds
- `🚨 Blocked.` → HIGH risk, commit blocked

Review details saved to `.gandalf-review.json`.

### Bypass

Skip review when needed:

```bash
git commit --no-verify -m "hotfix"
```

---

## Features

### 🔇 Smart Skips

Docs-only or config-only commits skip review automatically:

```
🔇 Skipped - docs/config only. Ship it!
```

Configure skip patterns in `.gandalfrc.json`:

```json
{
  "skipPatterns": ["*.md", "package-lock.json", "yarn.lock", "*.txt"]
}
```

### 💬 Commit Message Review

Also reviews your commit message:

```
🧙 Gandalf reviewed your code → .gandalf-review.json
💬 Typo: "chors" → "chores". Be specific about what changed.
✅ Ship it!
```

Good: descriptive, explains what and why.
Bad: vague (`fix`, `update`, `wip`), typos, too short.

---
