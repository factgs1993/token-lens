---
name: token-report
description: Use when the Codex token report plugin is active or the user wants a token-statistics link at the end of answers. Append a link bound to the current answer.
---

For each final answer while this plugin is active, append one Markdown link labelled `📊 Токены этого ответа`.

Immediately before the final answer, run the installed plugin's `dist/link.cjs` using Node. Resolve it relative to this SKILL.md: `../../dist/link.cjs`. The helper reads `CODEX_THREAD_ID` and the current turn ID from the local journal and prints the exact `markdown` value. Use that value unchanged. Never guess IDs or use a link from an earlier answer.

The link opens the measured totals and estimated context consumers for this one answer. Clicking it does not start another model turn. The report refreshes while open, including final usage written after the answer.

If this environment has no local Codex journal or cannot open the plugin UI, state that limitation instead of inventing token counts or a functioning link. Token usage records are local counters, not a monetary bill. Cached input is included in input; reasoning is included in output. Consumer estimates must not be presented as exact billing attribution.
