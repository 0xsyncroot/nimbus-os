# Providers

> How to configure, switch, and mix LLM providers. Anthropic, OpenAI-compatible (Groq, DeepSeek, Azure, vLLM, LiteLLM), and Ollama.

## 1. Supported providers

| Provider | Key prefix | Protocol | Base URL | Notes |
|----------|-----------|----------|----------|-------|
| Anthropic | `sk-ant-` | Anthropic native | `api.anthropic.com` | Prompt caching, extended thinking |
| OpenAI | `sk-` or `sk-proj-` | OpenAI REST | `api.openai.com` | o-series reasoning tokens |
| Groq | `gsk_` | OpenAI-compat | `api.groq.com/openai/v1` | Free tier, very fast llama-3.3-70b |
| DeepSeek | `sk-` | OpenAI-compat | `api.deepseek.com` | Cheap, good reasoning |
| Ollama | none | OpenAI-compat | `localhost:11434/v1` | Local, zero cost |
| Azure OpenAI | `sk-` or deployment | OpenAI-compat | custom per-deployment | Via base URL |
| vLLM | any | OpenAI-compat | custom | Self-hosted inference |
| LiteLLM proxy | any | OpenAI-compat | custom | Multi-provider routing |

## 2. First-time setup

Easiest: `nimbus init` wizard asks for provider + key; key goes to your OS keyring. See [getting-started §1c](./getting-started.md).

Post-init:
```bash
nimbus key set anthropic           # masked prompt, stored in keyring
nimbus key set openai              # add another provider
nimbus key list                    # shows redacted entries (sk-ant-****abcd)
nimbus key test anthropic          # 1-call ping, ~$0.00001 cost, 5s hard timeout
nimbus key delete anthropic --yes  # confirm required
```

CI / scripts:
```bash
echo "$KEY" | nimbus key set anthropic --key-stdin
nimbus key set anthropic --key-from-env ANTHROPIC_API_KEY
```

## 3. Custom base URL (Azure, vLLM, LiteLLM, proxies)

```bash
nimbus key set openai --base-url https://mycompany.openai.azure.com/openai/deployments/gpt4
nimbus key set openai --base-url http://localhost:8000/v1    # local vLLM
nimbus key set openai --base-url https://litellm.internal/v1  # LiteLLM proxy
```

The base URL becomes part of the workspace config (`providers.openai.baseUrl`). Safe to commit — only `keyRef` is stored, actual key stays in keyring.

## 4. Switch in-REPL (no restart)

```
nimbus > /provider anthropic
nimbus > /model workhorse
nimbus > /provider groq
nimbus > /model budget
```

`/model` takes a class name. Classes map per-provider:

| Class | Anthropic | OpenAI | Groq | DeepSeek | Ollama |
|-------|-----------|--------|------|----------|--------|
| `flagship` | opus-4-6 | o1 | — | — | — |
| `workhorse` | sonnet-4-6 | gpt-4o | — | v3 | — |
| `budget` | haiku-4-5 | gpt-4o-mini | llama-3.3-70b | v3 | llama3 (default) |
| `reasoning` | opus-4-6 thinking | o1 | — | v3 | — |
| `local` | — | — | — | — | any Ollama model |

Concrete model override: `/model claude-haiku-4-5`.

## 5. Priority chain (where does the key come from)

When nimbus needs a key, it checks in order — first non-empty wins:

1. `--api-key` CLI flag (one-off override)
2. Environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`)
3. Secret store (keyring / AES-GCM file — what `nimbus key set` uses)
4. Config `keyRef` field (points at a keyring entry)
5. Error `P_AUTH`

This matches the SPEC-501 6-layer config precedence. Env var wins over stored secret so you can temporarily override without mutating state.

## 6. Per-workspace isolation

Keys are namespaced per workspace. Service: `nimbus-os.{workspaceId}`. Account: `provider:{providerId}`.

Your `work` workspace and `personal` workspace can have different keys for the same provider. `/workspaces` and `/switch` rotate through them.

If workspace A has no key for provider X, nimbus falls back to the user-global key (if any) with a banner. Refuse behavior configurable in v0.3.

## 7. Model classes — when to use which

- **`budget`**: read/Grep/Glob turns, consolidation, reflection, heartbeat, drift detection. Haiku / gpt-4o-mini / llama-3.3-70b. Default class for non-interactive work.
- **`workhorse`**: standard REPL turns, code edits, reasoning over 5-10 files. Sonnet / gpt-4o / DeepSeek v3. Default for REPL.
- **`flagship`**: hard reasoning, long contexts, synthesis across many sources. Opus / o1. Use sparingly — 5-15× cost of workhorse.
- **`reasoning`**: extended thinking / o-series explicit reasoning tokens. Same models as flagship with thinking enabled (SPEC-116).
- **`local`**: offline / zero-cost / privacy-critical. Ollama. Expect lower quality; good for drafts or bulk reads.

Set default class in workspace config, override per-turn with `/model`.

## 8. Prompt caching (Anthropic-specific)

nimbus sets cache breakpoints at:
- End of SOUL.md + IDENTITY.md + static prompt sections (breakpoint 1)
- End of TOOLS.md manifest (breakpoint 2)

First turn: full prompt charged. Turn 2+ in same session: ~90% cache hit rate (cached reads are 10% base price per META-004 + SPEC-701 price table).

OpenAI auto-caches prompts ≥1024 tokens; nimbus benefits without config. Groq / DeepSeek / Ollama don't cache — costs are linear in input tokens.

## 9. Extended thinking (Anthropic workhorse+)

Sonnet 4.5+ / Opus 4.6+ support extended thinking. nimbus requests `thinking: { budget_tokens: 2048 }` by default when the model supports it. Thinking blocks persist to `events.jsonl` but NOT shown in REPL unless you `/show-thinking on`.

Cost: counted as `reasoningTokens` in CostEvent. Same price as output tokens for Anthropic.

Disable: set `thinking.budgetTokens: 0` in workspace config.

## 10. Ollama / local

```bash
ollama serve                       # default port 11434
ollama pull llama3.3:70b           # or any model
nimbus key set ollama --base-url http://localhost:11434/v1   # no key needed, but set for override
nimbus --provider ollama --model llama3.3:70b
```

Nothing leaves the machine. Cost rows show `$0.00`. Expect latency 2-10× higher than cloud APIs on typical hardware.

## 11. Fallback & error handling

Provider errors route through ErrorCode taxonomy (META-003):

- `P_NETWORK`, `P_5XX` — retried with exp backoff (3 attempts)
- `P_429` — respect `retry-after`; try next model class in chain (v0.2 self-heal)
- `P_AUTH` (401/403) — escalate to user; nimbus will NOT silently retry with a different key
- `P_CONTEXT_OVERFLOW` — triggers compaction (v0.2) or error with summary

Circuit breaker opens after 3 consecutive errors → pauses further calls for 60s.

## 12. Config file reference

`~/.nimbus/workspaces/{ws}/workspace.json` excerpt:

```json
{
  "provider": {
    "default": "anthropic",
    "model": "claude-sonnet-4-6"
  },
  "providers": {
    "anthropic": { "keyRef": "keyring:nimbus-os.personal/anthropic" },
    "openai": {
      "baseUrl": "https://mycompany.openai.azure.com/openai/deployments/gpt4",
      "keyRef": "keyring:nimbus-os.personal/openai"
    },
    "ollama": { "baseUrl": "http://localhost:11434/v1" }
  }
}
```

NEVER commit a key value in this file. The schema refinement `containsRawSecret` rejects it at load (`S_CONFIG_INVALID`).

## See also

- [Getting started](./getting-started.md)
- [Cost](./cost.md)
- [Security](./security.md)
- Canonical IR contract: `specs/00-meta/META-004-canonical-ir.spec.md`
- Provider adapter specs: SPEC-202 (Anthropic), SPEC-203 (OpenAI-compat)
