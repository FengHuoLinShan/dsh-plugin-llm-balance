# dsh-plugin-llm-balance

> 🏷️ Part of the **DSH official plugin ecosystem** (git tag: `dsh-official-plugin`; GitHub topics: `dsh-plugin` · `deepseek-harness`).
>
> English | [中文](README.md)

A general-purpose [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin: a **draggable, minimal rounded card** (DeepSeek web style) pinned to the top-right of the Web GUI that **always shows the balance/quota of your most recently used providers (up to 3)** — recently used DeepSeek and Kimi For Coding appear side by side:

- **Recent providers (≤3)**: collects the providers of all non-blank sessions (incremental cache, zero extra RPCs in steady state), ranked by each provider's most recent session activity (`updatedAt`), and keeps showing the top 3. New sessions bring new providers into view automatically; deleting a session removes its row.
- **Balance-type** (DeepSeek / Moonshot platform) color-coded by amount:

  | Color | Balance | Meaning |
  |---|---|---|
  | 🟢 Green | >= 100 | Healthy |
  | 🟡 Yellow | 20 ~ 99 | Okay |
  | 🔴 Red | 1 ~ 19 | Low |
  | ⚪ Gray | < 1 | Depleted; or query failure / loading |

- **Quota-type** (Kimi For Coding subscription) color-coded by remaining ratio: green >= 50%, yellow 20–50%, red 5–20%, gray < 5%. Usage is broken down by window — each row shows **both the 5h limit and the weekly limit percentages** (e.g. `5h 68% · 周 74%`, each window colored by its own ratio); the status dot uses the most conservative (lowest) window. Tooltip lists each window's `remaining x/y (p%) · reset date` plus the membership level; legacy responses without window details fall back to a single weekly window.
- **Auto-discovery**: queryable providers = built-in table (deepseek / deepseek-official / moonshotai / moonshotai-cn / kimi-coding) ∪ routes declared in the `llm-pi-ai.providers.*` settings namespace (e.g. `kimi-coding`) ∪ the plugin's own config — no per-provider setup needed.
- **Drag** anywhere; the position is remembered in `localStorage`.
- **Click** to refresh immediately.
- **Polling**: every 60 s by default; paused while the tab is hidden, refreshed on return.

## How it works

- **Host half** (`lib/index.js`): a Cordis plugin registering `GET /plugins/llm-balance` on the WebServer. It auto-discovers providers and resolves each provider's API key through `ctx.credentials` (the same env / `~/.dsh/.credentials.yaml` / `.env` seam as `llm-pi-ai`), then proxies the balance/quota query **server-side** — the browser never touches any key. Same-source provider ids (apiKeyEnv+baseURL) are queried only once. Failures return stable error codes only. Interface fields are parsed per the real official shapes: DeepSeek `total_balance` is a string, Kimi `limits[].window` is a `{duration, timeUnit}` object (300 min → `5h`, 7 days → `weekly`).
- **Client half** (`lib/client.js`): a browser bundle registered into the `shell.overlay` slot declared by `ui-layout` (kind:list / root scope), mounted/unmounted by the slot lifecycle (auto-disposed on declaration collapse or plugin unload). It collects non-blank sessions from `sessions.list`, incrementally reads each session's provider and recency via `connection.api.sessions.models` (the callUnary `result.value` contract), and renders the top 3 providers. Styles are injected idempotently via the official `data-plugin-css` pattern; `react` comes from the host module table seed — zero external dependencies, no build step.
- **Supported provider APIs**:

  | provider id | API | Basis |
  |---|---|---|
  | deepseek / deepseek-official | `GET https://api.deepseek.com/user/balance` | Balance (CNY; official `total_balance` is a string, numbers also accepted) |
  | moonshotai / moonshotai-cn | `GET https://api.moonshot.cn/v1/users/me/balance` | Balance (CNY) |
  | kimi-coding | `GET https://api.kimi.com/coding/v1/usages` | Subscription quota (top-level usage = weekly limit + per-window details (5h throttle etc.), membership level included) |

  Other routes declared in `llm-pi-ai` without a built-in balance API are reported honestly as `no_balance_api`, never as a configuration error.

## Install

The plugin ships in the **official bundle form** (`dsh.bundle.patch` activation layer + `dsh.client` browser half, per the [official packaging doc](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)) — a single `dsh plugin add` both installs and activates it (auto-appended to the profile's `bundles` layer):

```bash
# A (recommended): from npm (after publish)
dsh plugin --profile web add dsh-plugin-llm-balance

# B: from GitHub (source checkout, no build needed)
dsh plugin --profile web add "github:FengHuoLinShan/dsh-plugin-llm-balance#main"

# C (local development): from a checkout
dsh plugin --profile web add /path/to/dsh-plugin-llm-balance

# D (any version): from a tarball
dsh plugin --profile web add ./dsh-plugin-llm-balance-0.2.0.tgz
```

Restart the dsh service (plugin-set changes need a restart; afterwards client-bundle edits hot-reload via HMR), then refresh the page.

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

Multi-provider mode works out of the box: the provider list comes from the built-in table + `llm-pi-ai` settings; keys resolve from DSH credentials (`apiKeyEnv` of `llm-pi-ai` routes, or the built-in defaults `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `KIMI_CODING_API_KEY`).

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
- Balance/quota data comes from official APIs and may lag slightly; informational only.
- **Trust boundary**: `/plugins/llm-balance` is a bare HTTP route on the WebServer — no auth, no pairing PIN; it relies on the webserver's default loopback bind. If bound to `--host 0.0.0.0`, LAN clients could read configuration facts such as which providers have keys configured and their balance/quota numbers (the response never contains key values). Keep the default loopback deployment. The route is a custom one because the `api-remotes` domain (`/api` trust fence) is generated at build time inside the DSH repo and cannot be extended by third-party standalone plugins.

## License

MIT
