# 🧙 Git Gandalf

**Git Gandalf** is a local, LLM-powered **pre-commit code reviewer**.

It reads your **staged Git diff**, sends it to a **locally running LLM**, and decides whether your commit should be **allowed, warned, or blocked** - all before the commit is created.

- Runs locally
- No cloud calls
- No frameworks
- Uses a raw Git pre-commit hook + Node.js

> *“You Shall Not Commit” - when the risk is too high.*
