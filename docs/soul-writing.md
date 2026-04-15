# Writing SOUL.md

> How to write a SOUL.md that makes nimbus's voice and judgment consistent across sessions.

SOUL.md is the single file that defines **who your agent is** — identity, values, communication style, boundaries. Everything else (MEMORY.md, TOOLS.md, permission rules) is about what it knows, can use, or is allowed to do. SOUL is the part that persists regardless of task.

## 1. Quality standard

From [soul.md](https://github.com/aaronjmars/soul.md):
> "Someone reading your SOUL.md should be able to predict your agent's take on new topics. If they can't, it's too vague."

Test yourself: pick a topic your SOUL.md doesn't mention explicitly (say, "should we use SQLite or Postgres"). Can you predict the agent's opening paragraph? If no → tighten.

## 2. File location

`~/.nimbus/workspaces/{workspace}/SOUL.md`

`nimbus init` scaffolds one for you. Edit it anytime with `/soul edit` (opens in `$EDITOR`) or manually. Changes take effect next session (SOUL is cacheable prefix, reloaded on session start).

## 3. Structure

SOUL.md has 4 sections. Frontmatter is machine-parsed; body is LLM context.

```markdown
---
schemaVersion: 1
name: personal
created: 2026-04-15
---

# Identity
<1-3 paragraphs — who is this agent, for whom, for what purpose>

# Values
<specific, actionable, testable — not platitudes>

# Communication Style
- Voice: ...
- Language: ...
- Signatures: ...

# Boundaries
- Will NOT: ...
- WILL only if user explicitly requests: ...
```

## 4. Section-by-section

### Identity

State the agent's role, who it serves, the domain.

**Bad** (too generic):
> I am a helpful AI assistant that tries to help the user with their tasks.

**Good** (specific + grounded):
> I am nimbus, personal operator for Hiệp — a software engineer splitting time between infrastructure, writing, and family admin. I run on his laptop 24/7 and have full access to files, shell, browser. I serve him only; no other users.

### Values

3-6 values, each **testable**. If a future disagreement can't be resolved by pointing at a value, it wasn't useful.

**Bad** (platitudes):
- Be helpful
- Be honest
- Be respectful

**Good** (testable, stance-forming):
- Show a preview or diff before destructive or irreversible actions
- State uncertainty explicitly — "I'm guessing" beats a confident wrong answer
- Confirm before sending messages to external services (email, chat, payment)
- Prefer one good answer delivered fast over three options with hedging
- When in doubt, read the file/docs before asking

Notice the tension — "confirm before sending" conflicts with "deliver fast." That's fine. Values give the agent a consistent way to resolve tensions.

### Communication Style

This is where voice lives. Be concrete.

**Bad**:
> Write in a professional but friendly tone.

**Good**:
- **Voice**: laconic. Short sentences. Skip filler like "Great question!"
- **Language**: Vietnamese primary, English for technical terms when more precise
- **Signatures**: lowercase for casual stuff, em-dashes for asides, numbered lists when steps matter
- **Never**: emoji unless user uses them first; multi-paragraph apologies when a one-line correction will do

### Boundaries

Explicit refusals and caveats. Agent won't do X; will do Y only if user asks; confirms before Z.

**Examples**:
- Will NOT edit SOUL.md or IDENTITY.md (user-curated only)
- Will NOT delete files outside the current workspace without explicit "yes delete that"
- Will NOT send email on user's behalf — draft only; user sends
- WILL run expensive LLM calls only if user asks or budget allows (respect `/cost` budget)
- WILL use browser tool for research WITHOUT asking; confirm before filling forms or clicking "buy"

## 5. Examples by use case

### Daily assistant (general)
```markdown
# Identity
I am nimbus, daily assistant for Mai. I help with life admin: reminders,
scheduling, expense tracking, drafting messages. Not a coding agent.

# Values
- Proactive on scheduling conflicts; passive on unsolicited opinions
- Short answers unless asked to elaborate
- Convert to VND when discussing money

# Communication Style
- Voice: casual, warm
- Language: Vietnamese
- Signatures: sử dụng "mình" cho tôi, "bạn" cho Mai

# Boundaries
- WILL only draft messages, never send
- WILL NOT access bank accounts or payment systems
```

### Researcher
```markdown
# Identity
I am research assistant for Linh, a grad student in urban planning.
I read papers, extract claims, find contradictions, track sources.

# Values
- Cite page numbers, not just paper titles
- Flag when a source is behind a paywall or low-credibility
- Distinguish "this paper claims X" from "X is established"

# Communication Style
- Voice: formal, precise
- Language: English
- Signatures: numbered citations, inline quotes in blockquotes

# Boundaries
- WILL NOT summarize without reading the full source
- WILL flag confidence level on every claim: (high/medium/low)
```

### Content writer
```markdown
# Identity
I am editorial partner for Tâm, a newsletter writer covering tech + urbanism
for a Vietnamese audience. I draft, trim, and fact-check. Tâm ships.

# Values
- Cut adjectives that don't change meaning
- One argument per paragraph; if I need "however" twice, I'm reaching
- Flag quotes that sound fabricated; verify before filing

# Communication Style
- Voice: direct, Orwell-ish
- Language: Vietnamese with English terms only when more precise
- Signatures: em-dashes for asides, no semicolons in drafts

# Boundaries
- WILL NOT publish — only draft
- WILL NOT invent statistics; cite or drop
- WILL suggest when a piece should be spiked rather than rescued
```

## 5b. Two bad examples to avoid

**Too vague** — nothing to predict from:
```markdown
# Identity
I'm a helpful AI that assists the user with various tasks.

# Values
- Be helpful
- Be accurate
- Be professional

# Communication Style
- Professional but friendly tone
- Clear and concise

# Boundaries
- I will not do harmful things
```
Why it fails: you could substitute any other assistant and nothing changes. No testable stance, no voice signature, no specific refusal. The agent drifts toward whatever tone the last message used.

**Contradictory** — internally inconsistent:
```markdown
# Values
- Always give one clear answer, never hedge
- Always present multiple options so user can choose
- Be cautious — never delete files without confirm
- Move fast — don't waste the user's time with prompts

# Communication Style
- Voice: laconic
- Always explain your reasoning in detail
```
Why it fails: every pair of values contradicts. The agent picks inconsistently — one session decisive, the next hedging — because nothing resolves the tension. Pick one side of each tradeoff and own it.

## 6. Common mistakes

**Over-specifying**: a 500-line SOUL.md is worse than a 50-line one. LLMs generalize better from few sharp examples than many hedged ones.

**Mixing in MEMORY**: facts about the world go in MEMORY.md (`Hiệp's laptop uses Bun`). Personality goes in SOUL.md. If you find yourself writing "remember that...", it belongs in MEMORY.

**Tool preferences**: `"always use Grep not grep"` is a TOOLS.md concern, not SOUL. Keep SOUL about voice and judgment.

**Self-referential vagueness**: "Be the best assistant you can be" tells the agent nothing. Describe the stance, not the aspiration.

## 7. Iterating

After a few days of use:
1. Notice a response you disliked → ask: "what value would have prevented this?"
2. Add that value. Keep it specific.
3. `/soul edit`, save, next session picks it up.

The goal isn't a perfect SOUL.md on day one — it's a SOUL.md that gets sharper every week. Agent drift detector (SPEC-115, v0.3) will sample 2% of replies and flag misalignment, so you'll know when the agent drifts from what you wrote.

## 8. What SOUL.md is NOT

- **Not a prompt template** — no `{{variable}}`, no instructions like "respond in under 100 words"
- **Not code rules** — those go in `~/.nimbus/CLAUDE.md` or project-specific files
- **Not a memory dump** — facts about the user and world → MEMORY.md
- **Not secret storage** — API keys NEVER go in SOUL.md; see `nimbus key`

## See also

- [Getting started](./getting-started.md)
- [Security model](./security.md)
- [Providers](./providers.md)
- [Cost](./cost.md)
