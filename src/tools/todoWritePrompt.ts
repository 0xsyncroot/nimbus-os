// todoWritePrompt.ts — SPEC-132: TodoWriteTool system prompt with nimbus behavior rules.

export const TODO_WRITE_PROMPT: string = `
TodoWrite replaces the current todo list with a complete new snapshot. Use it to plan and track multi-step tasks.

## When to invoke
- Invoke when the task has 3 or more distinct steps, OR the user lists multiple items to complete.
- Do NOT invoke for simple single-step requests.

## Status rules (critical)
1. Mark items \`in_progress\` BEFORE starting work on them — never start work before updating status.
2. Only ONE item may be \`in_progress\` at any time.
3. Mark items \`completed\` IMMEDIATELY after success — never batch multiple completions together.
4. If blocked on a step, keep it \`in_progress\` and add a new \`pending\` item describing the blocker/next action.
5. Mark items \`cancelled\` when the user redirects away from a task.

## Full-list replacement
Each TodoWrite call sends the COMPLETE list — include all items (completed, in_progress, and pending).
Omitting an item removes it from the plan. Never send partial updates.

## Fields
- \`id\`: stable ulid — preserve across calls to maintain continuity.
- \`content\`: imperative infinitive ("Research destinations under 10M VND").
- \`activeForm\`: present continuous shown while in_progress ("Researching destinations").
- \`priority\`: optional — set when priority meaningfully differs between items.

## Example: travel planning

User: "Lên kế hoạch chuyến đi 3 ngày từ Hà Nội — budget 10 triệu"

Turn 1 — create plan:
\`\`\`json
{ "todos": [
  { "id": "01HX1...", "content": "Research destinations under 10M VND",
    "activeForm": "Researching destinations", "status": "in_progress",
    "createdAt": 1714000000000, "updatedAt": 1714000000000 },
  { "id": "01HX2...", "content": "Compare transport and hotel prices for 3 options",
    "activeForm": "Comparing prices", "status": "pending",
    "createdAt": 1714000000000, "updatedAt": 1714000000000 },
  { "id": "01HX3...", "content": "Recommend top pick with cost breakdown",
    "activeForm": "Writing recommendation", "status": "pending",
    "createdAt": 1714000000000, "updatedAt": 1714000000000 }
]}
\`\`\`

Turn 2 — after research done, start comparing:
\`\`\`json
{ "todos": [
  { "id": "01HX1...", "content": "Research destinations under 10M VND",
    "activeForm": "Researching destinations", "status": "completed",
    "createdAt": 1714000000000, "updatedAt": 1714000001000 },
  { "id": "01HX2...", "content": "Compare transport and hotel prices for 3 options",
    "activeForm": "Comparing prices", "status": "in_progress",
    "createdAt": 1714000000000, "updatedAt": 1714000001000 },
  { "id": "01HX3...", "content": "Recommend top pick with cost breakdown",
    "activeForm": "Writing recommendation", "status": "pending",
    "createdAt": 1714000000000, "updatedAt": 1714000000000 }
]}
\`\`\`
`.trim();
