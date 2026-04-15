# nimbus-os Examples

Templates bạn có thể copy vào workspace để tham khảo khi viết SOUL.md.

## SOUL templates (`souls/`)

| Template | Phù hợp với | Trait chính |
|----------|-------------|-------------|
| [daily-assistant](./souls/daily-assistant.SOUL.md) | Trợ lý hằng ngày, life admin | Casual, concrete, confirm before irreversible |
| [researcher](./souls/researcher.SOUL.md) | Deep-dive, compare, synthesize | Laconic precise, always-cite, quantify uncertainty |
| [writer](./souls/writer.SOUL.md) | Draft, edit, polish content | Direct editor, author's-voice-first, show-before-write |
| [software-dev](./souls/software-dev.SOUL.md) | Code review, refactor, test | Read-before-write, smallest-diff, explain-tradeoff |

## Cách dùng

```bash
# Sau `nimbus init`, copy template bạn thích đè lên SOUL.md:
cp examples/souls/researcher.SOUL.md ~/.nimbus/workspaces/personal/SOUL.md

# Hoặc edit trong REPL:
nimbus
> /soul edit
```

## Tự viết SOUL.md

Đọc [docs/soul-writing.md](../docs/soul-writing.md) để học cách viết hiệu quả.

Quality standard:
> Someone reading your SOUL.md should predict your takes on new topics. If they can't, it's too vague.

Template trống: [specs/templates/feature.spec.md](../specs/templates/feature.spec.md) — à không, đó là dev spec. User SOUL template theo format META-005:

```markdown
---
schemaVersion: 1
name: <your-workspace>
created: YYYY-MM-DD
---

# Identity
<1-3 đoạn: agent là ai, làm gì, cho ai, purpose>

# Values
- <specific actionable value — not platitude>
- ...

# Communication Style
- Voice: <formal/casual/laconic/verbose>
- Language: <en / vi / mix>
- Examples: <phrasing signatures>

# Boundaries
- Will NOT: ...
- Will only if user explicit: ...
```
