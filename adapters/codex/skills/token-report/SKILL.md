---
name: token-report
description: Use when the Codex token report plugin is active or the user wants a token-statistics link at the end of answers. Append a link bound to the current answer.
---

For each final answer while this plugin is active, append exactly the helper's single Markdown link labelled `📊 Токены этого ответа`. Do not add a second HTML link.

Immediately before the final answer, run the installed plugin's `dist/link.cjs` using Node. Resolve it relative to this SKILL.md: `../../dist/link.cjs`. The helper reads `CODEX_THREAD_ID` and the current turn ID from the local journal and prints the exact `markdown` value. Use that value unchanged. Never guess IDs or use a link from an earlier answer.

The link opens the measured totals and estimated context consumers for this one answer. Clicking it does not start another model turn. The report refreshes while open, including final usage written after the answer.

The helper reads `~/.codex/token-lens/config.json` (or under CODEX_HOME) each time: `reportView: "mcp"` opens the built-in panel; `reportView: "browser"` opens the independent HTML report. First use creates the default MCP configuration; installation and updates preserve an existing choice. Changing this file takes effect on the next generated link without reinstalling or restarting Codex. Existing links keep their original destination. Do not change the user's preference unless asked.

Both views include a bounded prompt preview, turn history, and measured chat totals. HTML/JSON exports are available inside the report. Never open a report automatically. On configuration errors or browser startup failures, state the specific failure instead of inventing a link or silently switching modes.

The account limits section uses Codex App Server rate-limit snapshots: remaining percentages, window lengths and reset times. These apply to the whole account, not to the selected answer. A fixed count of remaining requests is not provided. Do not convert percentages into invented request counts or infer recovery from an elapsed reset time; unavailable and stale limits must stay labelled.

If this environment has no local Codex journal or cannot open the plugin UI, state that limitation instead of inventing token counts or a functioning link. Token usage records are local counters, not a monetary bill. Cached input is included in input; reasoning is included in output. Consumer estimates must not be presented as exact billing attribution.
