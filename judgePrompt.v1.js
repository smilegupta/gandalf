"use strict";

const PROMPT_VERSION = "judge.v1";

function buildJudgePromptV1({ metadataJson, diffText, commitMessage }) {
  const hasCommitMsg = commitMessage && commitMessage.trim().length > 0;

  return [
    `GITGANDALF_PROMPT_VERSION: ${PROMPT_VERSION}`,
    "",
    "ROLE:",
    "You are a senior software engineer performing a structured code review for a single git commit diff.",
    "You are NOT a chatbot. You must follow the output contract exactly.",
    "",
    "TASK:",
    "Analyze the diff and return a strict JSON object describing risk and issues.",
    hasCommitMsg
      ? "Also review the commit message for clarity and usefulness."
      : "",
    "",
    "OUTPUT CONTRACT (MUST FOLLOW):",
    "- Output MUST be valid JSON only. No markdown. No backticks. No extra text.",
    "- Output MUST contain exactly these keys: risk, issues, summary, messageReview",
    "- risk MUST be one of: LOW, MEDIUM, HIGH",
    "- issues MUST be an array of strings (can be empty)",
    "- summary MUST be a string (1-3 sentences)",
    "- messageReview MUST be a string (feedback on the commit message, or empty if none provided)",
    "",
    "COMMIT MESSAGE GUIDELINES:",
    "- Good: descriptive, explains what and why",
    "- Bad: vague ('fix stuff', 'update', 'wip'), too short, typos, no context",
    "- If message is bad, give brief, direct feedback in messageReview (no jokes, no references)",
    "",
    "FAILURE RULES:",
    "- If you cannot comply, still output JSON with the exact keys and set risk=HIGH with issues explaining why.",
    "",
    "INPUTS:",
    hasCommitMsg
      ? `COMMIT MESSAGE: "${commitMessage.trim()}"`
      : "COMMIT MESSAGE: (not provided)",
    "",
    "DIFF METADATA (JSON):",
    metadataJson,
    "",
    "RAW DIFF:",
    diffText,
    "",
    "REMINDER:",
    "Return JSON ONLY with keys: risk, issues, summary, messageReview",
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = { buildJudgePromptV1, PROMPT_VERSION };
