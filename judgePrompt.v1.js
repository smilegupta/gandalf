"use strict";

const PROMPT_VERSION = "judge.v1";

function buildJudgePromptV1({ metadataJson, diffText }) {
  return [
    `GITGANDALF_PROMPT_VERSION: ${PROMPT_VERSION}`,
    "",
    "ROLE:",
    "You are a senior software engineer performing a structured code review for a single git commit diff.",
    "You are NOT a chatbot. You must follow the output contract exactly.",
    "",
    "TASK:",
    "Analyze the diff and return a strict JSON object describing risk and issues.",
    "",
    "OUTPUT CONTRACT (MUST FOLLOW):",
    "- Output MUST be valid JSON only. No markdown. No backticks. No extra text.",
    "- Output MUST contain exactly these keys: risk, issues, summary",
    "- risk MUST be one of: LOW, MEDIUM, HIGH",
    "- issues MUST be an array of strings (can be empty)",
    "- summary MUST be a string (1-3 sentences)",
    "",
    "FAILURE RULES:",
    "- If you cannot comply, still output JSON with the exact keys and set risk=HIGH with issues explaining why.",
    "",
    "INPUTS:",
    "DIFF METADATA (JSON):",
    metadataJson,
    "",
    "RAW DIFF:",
    diffText,
    "",
    "REMINDER:",
    "Return JSON ONLY.",
  ].join("\n");
}

module.exports = { buildJudgePromptV1, PROMPT_VERSION };
