# Getting Started với nimbus-os

> AI OS cá nhân chạy local 24/7. 5 phút từ install → chat lần đầu.

## 1. Cài đặt

### 1a. Yêu cầu
- **Bun ≥ 1.2** ([install guide](https://bun.sh/docs/installation))
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- macOS / Linux / Windows 10 v1809+
- 1 trong các API key:
  - **Anthropic** (recommended): https://console.anthropic.com → API Keys
  - **Groq** (free tier rất nhanh): https://console.groq.com/keys
  - **DeepSeek** (rẻ): https://platform.deepseek.com
  - **Ollama** (local, miễn phí): https://ollama.ai

### 1b. Clone + install (dev mode hôm nay)
```bash
git clone https://github.com/your-org/nimbus-os.git
cd nimbus-os
bun install
```

> v0.4+ sẽ có binary qua `brew install nimbus` / `scoop install nimbus` / `curl install.nimbus.ai | sh`.

### 1c. Set API key

**Recommended** — chạy `nimbus init` (§2 bên dưới) và wizard sẽ hỏi key lần đầu, lưu thẳng vào OS keychain (macOS Keychain / Linux Secret Service / Windows Credential Manager) qua AES-GCM fallback. Không cần touch env vars.

Sau init, manage keys qua `nimbus key`:
```bash
nimbus key set anthropic              # masked prompt, lưu vào secret store
nimbus key set anthropic --base-url https://api.example.com   # custom endpoint (Azure / vLLM / LiteLLM)
nimbus key set anthropic --test       # set + 1-call live test (max_tokens=1, ~$0.00001)
nimbus key list                       # in danh sách (redacted: sk-ant-***ABCD)
nimbus key test anthropic             # ping key (5s timeout)
nimbus key delete anthropic --yes     # confirm required
```

Pipe key cho CI / scripts:
```bash
echo "$MY_KEY" | nimbus key set anthropic --key-stdin
nimbus key set anthropic --key-from-env MY_ANTHROPIC_KEY
```

Ollama (local) không cần key — chỉ `ollama serve` rồi chọn provider `ollama` trong wizard.

**Env-var fallback (vẫn hỗ trợ)** — priority chain: `--api-key` flag > env var > secret store > config `keyRef` > error.
```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # vẫn được pickup tự động
export GROQ_API_KEY="gsk_..."
export DEEPSEEK_API_KEY="sk-..."
```
Env var override secret store nên hữu ích cho one-off testing.

## 2. First run — tạo workspace đầu tiên

```bash
bun run start init
```

Wizard sẽ hỏi 5-8 câu:
- **Workspace name**: `personal` / `work` / tên dự án — `[a-z0-9-]{1,32}`
- **Primary use case**: daily assistant / life organizer / student / researcher / writer / content creator / software dev
- **Language**: `en` hoặc `vi` (mặc định `vi` nếu LANG có "VN")
- **Voice**: `casual` / `formal` / `laconic` / `verbose`
- **Provider**: `anthropic` / `openai-compat:groq` / `openai-compat:deepseek` / `ollama`
- **Model**: `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-haiku-4-5` / `llama-3.3-70b` / etc.
- **Bash preset** *(chỉ hỏi nếu chọn dev use case)*: `strict` / `balanced` / `permissive`

Wizard tạo:
```
~/.nimbus/workspaces/{your-workspace-name}/
├── workspace.json       — metadata
├── SOUL.md              — identity + values + communication style + boundaries
├── IDENTITY.md          — role + background
├── MEMORY.md            — long-term durable facts (rỗng ban đầu)
├── TOOLS.md             — tool availability manifest
├── DREAMS.md            — dream consolidations (rỗng, populated từ v0.5)
└── .dreams/             — machine state
```

**Non-interactive mode** (tốt cho scripts/CI):
```bash
bun run start init --no-prompt --name personal --location ~/.nimbus
```

## 3. Vào REPL chat

```bash
bun run start
```

Sẽ thấy:
```
[OK] nimbus ready — workspace "personal" (claude-sonnet-4-6)
nimbus > _
```

Gõ ý tưởng tự nhiên cho bất kỳ domain nào:

```
nimbus > tóm tắt 5 file PDF mới nhất trong ~/Downloads
nimbus > research best laptop dưới 30 triệu, so sánh 5 options
nimbus > đọc README.md trong dự án này, cho tôi nhận xét
nimbus > xoá tất cả screenshots cũ hơn 30 ngày
nimbus > đặt lịch họp với Lan tuần sau 2pm
```

Agent sẽ:
1. **Detect độ phức tạp** (heuristic SPEC-108) — nếu non-trivial → enter plan mode
2. **Generate mini-spec nội bộ** (SPEC-110 Runtime SDD differentiator) — show inline FYI 5-8 lines
3. **Execute LUÔN** — không chờ user duyệt mỗi lần
4. **Confirm chỉ khi**: high-risk action (mass delete, send mail, payment) HOẶC user đã `/spec-confirm always`
5. **Persist spec** background vào `task-specs/<turnId>.spec.md` cho audit

User có thể:
- **Ctrl-C** lần 1: cancel turn hiện tại
- **Ctrl-C** lần 2: exit REPL
- `/stop` slash command: dừng agent giữa execution
- `/help`: xem 12 slash commands

## 4. Slash commands

| Command | Ý nghĩa |
|---------|---------|
| `/help` | List commands |
| `/quit` | Exit REPL |
| `/stop` | Cancel turn hiện tại |
| `/new` | New session trong cùng workspace |
| `/switch <id>` | Switch session |
| `/workspaces` | List workspaces |
| `/soul` / `/soul edit` | View / edit SOUL.md |
| `/memory` / `/memory edit` | View / edit MEMORY.md |
| `/provider <id>` | Switch provider (anthropic/groq/deepseek/ollama) |
| `/model <class>` | Switch model class (fast/balanced/heavy/reasoning) |
| `/cost` | Token + USD usage today |
| `/spec-confirm <on\|off\|always>` | Toggle Runtime SDD per-turn confirm |

## 5. Multi-workspace (advanced)

Tạo nhiều workspace cho mỗi context (work / personal / research):
```bash
bun run start init --name work --no-prompt
bun run start init --name personal --no-prompt
bun run start init --name research --no-prompt

# Workspace cuối tạo sẽ là active. Switch qua REPL:
bun run start
nimbus > /workspaces
nimbus > /switch work
```

Mỗi workspace có SOUL/MEMORY riêng → agent voice + history isolated.

## 6. Permission modes

```
nimbus > /mode readonly    # Chỉ Read/Grep/Glob, no Bash/Write/Edit
nimbus > /mode default     # (mặc định) confirm destructive ops
nimbus > /mode bypass      # KHÔNG confirm — DANGER. Cần env NIMBUS_BYPASS_CONFIRMED=1 + flag
```

Bypass mode requires both:
```bash
export NIMBUS_BYPASS_CONFIRMED=1
bun run start --dangerously-skip-permissions
```

## 7. Troubleshooting

**`U_MISSING_CONFIG: provider_key_missing`**
→ Run `nimbus key set <provider>` (recommended) hoặc set env var (xem §1c).

**`X_BASH_BLOCKED`**
→ Command bị tier-1 security block (rm -rf /, curl|sh, eval, sudo, etc.). Thiết kế intentional cho safety. Đổi cách diễn đạt request.

**`X_PATH_BLOCKED`**
→ Đang cố access sensitive path (.ssh/, .env, .aws/credentials, ~/.bashrc). pathValidator always-on cho security. Không bypass được.

**REPL không boot**
→ `bun run typecheck` xem errors. `bun test` xem regression.

**Cost ngoài expected**
→ `/cost` xem breakdown. Switch sang `groq` (free) hoặc `ollama` (local) để giảm cost.

## Next steps

- [SOUL writing guide](./soul-writing.md) — viết SOUL.md hiệu quả
- [Security model](./security.md) — threat model + permission system
- [Providers](./providers.md) — config đa provider chi tiết
- [Cost](./cost.md) — pricing + budget management
