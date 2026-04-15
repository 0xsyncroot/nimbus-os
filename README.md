# nimbus-os

> **AI OS cá nhân đa năng** — chạy local 24/7. Cho mọi user (không chỉ developer).
> Khác biệt: agent **tự suy nghĩ theo dạng spec** (5 sections) trước khi hành động → plan tốt hơn agent reactive thông thường. Tự chủ hoàn toàn, user KHÔNG cần duyệt mỗi lần. Permission gate riêng biệt là mạng an toàn cho destructive actions.

**Status**: v0.1 MVP — in development. See [plan](/root/.claude/plans/stateful-stargazing-ullman.md).

## Dùng để làm gì

- **🔬 Trợ lý nghiên cứu** — deep-dive topic, summarize sources, compare options
- **📅 Lên kế hoạch** — sự kiện, chuyến đi, dự án, lịch trình
- **📨 Quản lý communication** — email, lịch, tin nhắn (qua channels)
- **✍️ Viết content** — draft, edit, summarize, dịch
- **📁 Tổ chức file + dữ liệu** — đổi tên, gom nhóm, archive, dọn dẹp
- **🤖 Code assistance** — refactor, review, debug, write tests
- **🧠 Life admin automation** — reminders, expense tracking, habit logging
- **🌐 Web automation** — book vé, fill form, scrape data (v0.4 với browser)

## Đặc tính

- **🌟 Runtime SDD (differentiator)** — agent **tự generate mini-spec nội bộ** (5 sections) cho task non-trivial → show inline FYI → execute LUÔN. Spec là internal planning aid để agent suy nghĩ tốt hơn, KHÔNG phải UX gate. Permission gate (mode=default) handle destructive ops orthogonally. High-risk action tự flag → single confirm. User opt-in `/spec-confirm always` nếu muốn approve every spec.
- **Linh hồn nhất quán** — SOUL.md + IDENTITY.md + MEMORY.md persistent cross-session, voice riêng của agent
- **Tự chủ thực sự** — agent tự phân rã task, lập kế hoạch, thực thi (auto-plan detector cho task complex)
- **Đa channel** — CLI, HTTP/WS, Telegram, Slack, iMessage, Signal, WhatsApp (via plugin)
- **Multi-provider** — Anthropic + OpenAI-compatible (Groq/DeepSeek/Ollama/vLLM)
- **An toàn** — 5-layer defense: rules + bash security + path validator + network policy + sandbox
- **Self-healing** — tự sửa error reversible, escalate irreversible
- **Tự hoàn thiện** — Dreaming + memory consolidation + reflection journal (v0.2-v0.5)
- **Cost-aware** — tracking + budget + estimator + optimizer
- **Browser** — Playwright Chromium với ax-tree API + captcha UX (v0.4)

## Quick Start (user)

```bash
# 1. Cài Bun + clone
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/your-org/nimbus-os.git
cd nimbus-os && bun install

# 2. Set API key (1 trong các provider)
export ANTHROPIC_API_KEY="sk-ant-..."     # hoặc
export GROQ_API_KEY="gsk_..."             # free tier
# Hoặc Ollama local: ollama serve && ollama pull llama3 (không cần key)

# 3. Tạo workspace đầu tiên
bun run start init --name personal

# 4. Vào REPL chat
bun run start

# Trong session, gõ ý tưởng tự nhiên:
> tóm tắt 5 mail mới của tôi
> research best laptop dưới 30 triệu, so sánh 5 options
> dọn ~/Downloads, gom screenshots vào folder
> đặt lịch họp với Lan tuần sau

# Agent tự generate spec nội bộ → show inline FYI → execute luôn.
# Bạn có thể /stop hoặc comment để redirect bất cứ lúc nào.
# Destructive ops (rm, send mail, payment) tự confirm qua permission gate.
```

📖 **Chi tiết hơn**: [docs/getting-started.md](./docs/getting-started.md) (5 min read)

## Development (cho người build nimbus)

nimbus-os dùng **Spec-Driven Development**. Mọi feature có spec trước khi code.

```bash
bun run spec list      # Xem specs
bun run spec show SPEC-101
bun run spec validate  # Verify 6 elements + deps
```

- Specs: [`/specs/`](./specs/)
- AI memory: [`/CLAUDE.md`](./CLAUDE.md)
- Docs: [`/docs/`](./docs/)

## Security Notice

nimbus-os có **full access filesystem + shell + network + code execution**. Đọc [security.md](./docs/security.md) trước khi dùng. Default mode là `default` (confirm mọi write/bash); `auto` và `bypass` phải opt-in explicit.

## License

TBD (see plan open decisions).

## Acknowledgments

Cảm hứng + pattern từ: [OpenClaw](https://github.com/openclaw/openclaw), [Claude Code](https://claude.com/claude-code), [soul.md](https://github.com/aaronjmars/soul.md), [Spec Kit](https://github.com/github/spec-kit).
