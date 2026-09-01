# dsh-plugin-llm-balance

> 🏷️ Part of the **DSH official plugin ecosystem** (git tag: `dsh-official-plugin`; GitHub topics: `dsh-plugin` · `deepseek-harness`).
>
> English | [中文](README.md)

A general-purpose [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin: a **draggable, minimal rounded card** pinned to the top-right of the Web GUI that shows the balance/quota of the three most recently used providers, including API balances and common coding plans.

- **Recent providers (≤3)**: counts only successful model calls completed after the plugin is enabled and aggregates the three most recent distinct providers from persisted `sessions.list` projections. Membership updates in real time, while visible providers keep fixed slots: repeated use does not reorder rows, and a newcomer replaces only the evicted provider's slot. It does not scan old history, call `session.models`, or resume cold sessions.
- **Balance-type** (DeepSeek / Moonshot platform) color-coded by amount:

  | Color | Balance | Meaning |
  |---|---|---|
  | 🟢 Green | >= 100 | Healthy |
  | 🟡 Yellow | 20 ~ 99 | Okay |
  | 🔴 Red | 1 ~ 19 | Low |
  | ⚪ Gray | < 1 | Depleted; or query failure / loading |

- **Quota-type** (Kimi, Codex Connect, OpenCode Go, OpenRouter Key limits, MiniMax Token Plan, and Z.AI/BigModel Coding Plan) is color-coded by remaining ratio: green >= 50%, yellow 20–50%, red 5–20%, gray < 5%. Multi-window plans show 5h, daily, weekly, or monthly percentages and reset times; the status dot uses the lowest remaining window.
- **DeepSeek peak/off-peak pill**: DeepSeek balance rows carry a small `低谷/高峰` (off-peak/peak) badge — since 2026-08-17, peak hours are 09:00–12:00 and 14:00–18:00 Beijing time, and every other hour (including the 12:00–14:00 midday valley) is half price. Pure wall-clock math with no extra requests; the tooltip shows the schedule plus a countdown to the next switch, and the pill refreshes with the existing balance polling and visibility-resume refresh. Rows without a configured key carry no pill.
- **Auto-discovery**: queryable providers come from the built-in usage table, `llm-pi-ai.providers.*`, and the plugin's compatibility config.
- **Drag** anywhere; the position is remembered in `localStorage`.
- **Click** to refresh immediately.
- **Polling**: every 60 s by default; paused while the tab is hidden, refreshed on return.

## How it works

- **Host half** (`lib/index.js`): registers the new DSH state/wire projection contract and the `/llm-balance` Connection RPC channel. Explicit `apiKeyEnv` references are authoritative; otherwise the plugin reads the `llm-pi-ai/<provider>` API-key record before falling back to the provider's default environment reference. OAuth grants are never interpreted. Same-source queries are deduplicated.
- **Client half** (`lib/client.js`): aggregates the three most recent providers from every session's `projectionValues.llmBalanceRecentProviders` and queries balances for only those providers through Connection RPC. It refreshes immediately on mount, membership changes, and visibility restoration; recency-only order changes neither reorder rows nor trigger an extra request. While visible it polls every 60 seconds by default. Dragging, click-to-refresh, and card rendering are unchanged.
- **Supported provider APIs**:

  | provider id | API | Basis |
  |---|---|---|
  | deepseek / deepseek-official | `GET https://api.deepseek.com/user/balance` | Balance (CNY; official `total_balance` is a string, numbers also accepted) |
  | moonshotai / moonshotai-cn | `GET https://api.moonshot.ai/v1/users/me/balance` / `https://api.moonshot.cn/...` | International/CN balance (CNY) |
  | kimi-coding | `GET https://api.kimi.com/coding/v1/usages` | Subscription quota (top-level usage = weekly limit + per-window details (5h throttle etc.), membership level included) |
  | openai-codex | `dsh-codex-connect` (`GET https://chatgpt.com/backend-api/wham/usage`) | Codex Connect quota (primary `rateLimits` bucket (id `codex`, fallback first) windows = remaining percentage (limit=100; 18000s → 5h, 604800s → weekly, other durations get a stable label); optional individualLimit → monthly quota, credits → USD balance or a `Credits` segment (when `credits.unlimited=true`, rendered as finite 100/100 solely for the percentage UI — green 100% instead of gray ∞/∞; the account stays unlimited)) |
  | opencode-go | `GET https://opencode.ai/zen/go/v1/usage` | OpenCode Go subscription quota (`usage.rolling` → 5h, `usage.weekly` → weekly: `percent` is the used percentage → amount=100-percent, limit=100, `resetsAt` → reset time; `monthly` ignored; an invalid single window is skipped, at least one valid window required. ⚠️ Endpoint is currently undocumented and may change) |
  | openrouter | `GET https://openrouter.ai/api/v1/key` | Current key's daily/weekly/monthly spending limit; an unlimited key reports no remaining-balance metric |
  | minimax / minimax-cn | `GET https://www.minimax.io/v1/token_plan/remains` / `https://www.minimaxi.com/...` | Token Plan text-model 5h/weekly remaining ratio |
  | zai / zai-coding-cn | `GET https://api.z.ai/api/monitor/usage/quota/limit` / `https://open.bigmodel.cn/...` | Coding Plan 5h/weekly remaining ratio; MCP/tool-only limits are ignored |

  Other routes declared in `llm-pi-ai` without a built-in balance API are reported honestly as `no_balance_api`, never as a configuration error.

### OpenAI Codex (Codex Connect, optional)

- **Prerequisites**: to display quota, install and enable [dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) separately (`dsh plugin --profile web add dsh-codex-connect@alpha`, minimum compatible `0.1.0-alpha.4.5`) and complete its ChatGPT OAuth sign-in. With only DSH-native Codex OAuth, the row reports that Codex Connect is still required for quota.
- **No API key**: Codex uses ChatGPT OAuth — no `DEEPSEEK_API_KEY`-style credential is needed; sign-in state and quota reads go entirely through codex-connect's `OpenAICodexCredentialStore` wrapper. The plugin **dynamically imports** codex-connect only when `openai-codex` is queried. Module missing/incompatible or not signed in → `configured:false` (safe ref, no credentials); signed in but quota lookup fails → `status:error / error:unavailable`; success → the secret-free `OpenAICodexUsage` is mapped onto the existing quota shape.
- **Display**: 5h/weekly limits render as remaining percentages (e.g. `5h 74% · 周 68%`); accounts with a spend cap get an extra monthly (`月`) window; when codex-connect reports `credits.unlimited=true`, the account remains unlimited but the `Credits` segment renders as finite 100/100 solely for the existing percentage UI — green 100% instead of gray ∞/∞.
- **Security**: this plugin **never reads or copies** the OAuth document (`.openai-codex-auth.json`) directly; tokens never appear in responses, logs, or the page.

## Install

Requires DSH `0.1.1-rc.2` through `0.1.2-alpha.4`. The former uses loopback RPC authority; the latter uses the host's unified BrowserAuth RPC.

The plugin ships in the **official bundle form** (`dsh.bundle.patch` activation layer + `dsh.client` browser half, per the [official packaging doc](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)) — a single `dsh plugin add` both installs and activates it (auto-appended to the profile's `bundles` layer):

```bash
# A (recommended): from npm (after publish)
dsh plugin --profile web add dsh-plugin-llm-balance

# B: from GitHub (source checkout, no build needed)
dsh plugin --profile web add "github:FengHuoLinShan/dsh-plugin-llm-balance#main"

# C (local development): from a checkout
dsh plugin --profile web add /path/to/dsh-plugin-llm-balance

# D (any version): from a tarball
dsh plugin --profile web add ./dsh-plugin-llm-balance-0.3.0.tgz
```

Restart the dsh service (plugin-set changes need a restart; afterwards client-bundle edits hot-reload via HMR only while the DSH checkout's `pnpm run dev:web` watcher is running — otherwise reinstall/restart/refresh), then refresh the page.

> Tune it in `~/.dsh/profiles/web/cordis.patch.yml` by row id:
>
> ```yaml
> - update:
>     - id: llm-balance
>       config:
>         refreshMs: 30000
> ```

## Configuration

| Field | Default | Description |
|---|---|---|
| refreshMs | 60000 | Client polling interval (ms) |
| timeoutMs | 15000 | Server-side query timeout (ms) |
| provider | deepseek | (Legacy) single-provider mode; multi-provider mode needs no config — auto-discovery |
| apiKeyEnv | DEEPSEEK_API_KEY | (Legacy) credential reference name for single-provider mode |
| baseURL | per-provider default | (Legacy) optional base URL override for single-provider mode |

Multi-provider mode works out of the box: providers come from the built-in table plus `llm-pi-ai` settings. An explicit `apiKeyEnv` is resolved exclusively; otherwise the `llm-pi-ai/<provider>` API-key record is preferred before the provider's default environment reference. OAuth grants are not interpreted; Codex quota is managed by Codex Connect.

All fields are leniently validated: non-numeric / non-positive `refreshMs` / `timeoutMs`, non-string or empty `provider` / `apiKeyEnv`, non-string `baseURL` all fall back to defaults — the plugin never fails to start because of bad config (zero-dependency `normalizeConfig`, semantically equivalent to the official Config schema fallback).

## Self-test

```bash
node test/balance.test.mjs   # host-half logic tests (stubbed ctx + stubbed fetch)
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-llm-balance   # removes dependency and bundle layer
```

## Security notes

- API keys are resolved and used only server-side; they never appear in responses, logs, or the page.
- Balance endpoints are proxied by the server (same origin) — no CORS exposure, no key leakage.
- **OpenAI Codex has no API key**: quota reads go through `dsh-codex-connect`'s `OpenAICodexCredentialStore`; a DSH-native `llm-pi-ai` grant is used only as a configured-state signal and its OAuth payload is never parsed, copied, or refreshed here.
- Balance/quota data comes from official APIs and may lag slightly; informational only.
- **Trust boundary**: balance queries use `/llm-balance` Connection RPC. DSH 0.1.1 registers it as loopback-only; DSH 0.1.2 authenticates it through the host's unified BrowserAuth before invoking the handler.

## License

MIT
