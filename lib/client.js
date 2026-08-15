/**
 * dsh-plugin-llm-balance — client 半身（浏览器 bundle）。
 *
 * 渲染一个 DeepSeek 网页端式极简圆角卡片，固定于页面右上角起始，
 * **常态化显示最近使用的 ≤3 个 provider** 的余额/配额：
 *  - 从 sessions.list 的 llmBalanceRecentProviders 投影聚合最近使用的
 *    3 个不同 provider，不调用 session.models，不恢复冷会话；
 *  - 只请求这 3 个 provider 的余额，按最近使用顺序逐行渲染；
 *  - 余额型（deepseek / moonshot）按金额分档着色：
 *      绿 ≥ 100   黄 20~99   红 1~19   灰 <1 / 失败 / 加载中
 *    配额型（Kimi For Coding 套餐）按剩余比例分档，行内按窗口显示
 *    「周限额 / 5h 限额」双百分比（如 5h 74% · 周 55%）：
 *      绿 ≥ 50%   黄 20~50%   红 5~20%   灰 <5% / 失败 / 加载中
 *  - 点击刷新，拖动记忆位置（localStorage），标签页隐藏时暂停轮询。
 *
 * 挂载方式：注册到 ui-layout 声明的 shell.overlay 槽位（kind:list /
 * scope:root 弹层容器），由 slot 生命周期管理挂载与卸载；样式按官方
 * data-plugin-css 模式幂等注入。
 *
 * 本文件即最终产物（经典脚本，由模块系统注入）：不依赖构建工具，
 * react 由宿主模块表 seed 提供，无任何外部 import。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-llm-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		const STORAGE_KEY = "dsh-plugin-llm-balance.pos";
		const CARD_MIN_WIDTH = 180;
		const MARGIN = 8;
		/** 常态展示的最近 provider 数量上限。 */
		const MAX_RECENT_PROVIDERS = 3;
		const CARD_CSS_ID = "dsh-plugin-llm-balance/card.css";
		const CARD_CSS = [
			".dsh-balance-card{position:fixed;min-width:180px;max-width:280px;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:6px;display:flex;flex-direction:column;gap:2px;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;z-index:30;font-family:var(--dsw-font-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif);font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2937);transition:box-shadow .15s}",
			".dsh-balance-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.12)}",
			".dsh-balance-card.dragging{cursor:grabbing;box-shadow:0 6px 20px rgba(0,0,0,.16)}",
			".dsh-balance-row{display:flex;align-items:center;gap:8px;padding:3px 8px;border-radius:8px;white-space:nowrap}",
			".dsh-balance-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}",
			".dsh-balance-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#9ca3af}",
			".dsh-balance-dot.lv-green{background:#10b981}",
			".dsh-balance-dot.lv-yellow{background:#f59e0b}",
			".dsh-balance-dot.lv-red{background:#ef4444}",
			".dsh-balance-dot.lv-gray{background:#9ca3af}",
			".dsh-balance-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#6b7280)}",
			".dsh-balance-value{font-weight:600;font-variant-numeric:tabular-nums;color:#1f2937}",
			".dsh-balance-value.lv-green{color:#10b981}",
			".dsh-balance-value.lv-yellow{color:#b45309}",
			".dsh-balance-value.lv-red{color:#ef4444}",
			".dsh-balance-value.lv-gray{color:#9ca3af}",
			".dsh-balance-seg{margin-left:8px;font-weight:600;font-variant-numeric:tabular-nums}",
			".dsh-balance-seg:first-child{margin-left:0}",
			".dsh-balance-seg .dsh-balance-seg-label{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:500}",
			".dsh-balance-seg.lv-green{color:#10b981}",
			".dsh-balance-seg.lv-yellow{color:#b45309}",
			".dsh-balance-seg.lv-red{color:#ef4444}",
			".dsh-balance-seg.lv-gray{color:#9ca3af}",
			".dsh-balance-sep{margin-left:8px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
		].join("\n");
		// 官方 data-plugin-css 幂等注入模式（materialize 时执行一次；HMR 认领友好）。
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CARD_CSS_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CARD_CSS_ID);
			tag.textContent = CARD_CSS;
			document.head.append(tag);
		}

		/** 配额剩余比例分档等级（ratio ∈ [0,1]）。 */
		function levelForRatio(ratio) {
			if (ratio >= 0.5) return "green";
			if (ratio >= 0.2) return "yellow";
			if (ratio >= 0.05) return "red";
			return "gray";
		}

		function levelFor(entry) {
			const n = Number(entry && entry.amount);
			if (!Number.isFinite(n)) return "gray";
			if (entry && entry.kind === "quota") {
				// 多窗口（周/5h）时取最低百分比窗口的分档（保守：不掩盖最紧张的窗口）。
				if (entry.windows && entry.windows.length > 0) {
					let min = void 0;
					for (const w of entry.windows) {
						const pct = quotaPercentOf(w.amount, w.limit);
						if (pct !== void 0 && (min === void 0 || pct < min)) min = pct;
					}
					if (min !== void 0) return levelForRatio(min / 100);
					return n > 0 ? "yellow" : "gray";
				}
				const limit = Number(entry.limit);
				if (!Number.isFinite(limit) || limit <= 0) return n > 0 ? "yellow" : "gray";
				return levelForRatio(n / limit);
			}
			if (n >= 100) return "green";
			if (n >= 20) return "yellow";
			if (n >= 1) return "red";
			return "gray";
		}

		function formatAmount(amount) {
			const n = Number(amount);
			if (!Number.isFinite(n)) return "—";
			if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "w";
			if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
			if (n >= 100) return String(Math.round(n));
			if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
			return String(Math.round(n * 100) / 100);
		}

		function providerLabel(provider) {
			if (provider === "deepseek" || provider === "deepseek-official") return "DeepSeek";
			if (provider === "kimi-coding") return "Kimi For Coding";
			if (provider === "moonshotai") return "Moonshot";
			if (provider === "moonshotai-cn") return "Moonshot CN";
			return provider || "API";
		}

		function membershipLabel(level) {
			if (!level) return "";
			return { LEVEL_FREE: "Free", LEVEL_BASIC: "Basic", LEVEL_INTERMEDIATE: "Intermediate", LEVEL_PREMIUM: "Premium" }[level] || level;
		}

		/** 配额剩余百分比（0-100 整数）；limit 非法时 undefined。 */
		function quotaPercentOf(amount, limit) {
			const a = Number(amount);
			const l = Number(limit);
			if (!Number.isFinite(a) || !Number.isFinite(l) || l <= 0) return void 0;
			return Math.max(0, Math.min(100, Math.round((a / l) * 100)));
		}

		/** 窗口标签：已知取值（5h / weekly）本地化，未知原样显示。 */
		function windowLabel(window) {
			if (window === "5h") return "5h";
			if (window === "weekly") return "周";
			return window;
		}

		/** quota 数值段：多窗口各一段；无 windows 时回退单段（主 usage）。 */
		function quotaSegments(entry) {
			const segs = [];
			if (entry.windows && entry.windows.length > 0) {
				for (const w of entry.windows) {
					const pct = quotaPercentOf(w.amount, w.limit);
					segs.push({ key: w.window, label: windowLabel(w.window), pct, amount: w.amount, limit: w.limit, resetTime: w.resetTime });
				}
				return segs;
			}
			const pct = quotaPercentOf(entry.amount, entry.limit);
			segs.push({ key: "main", label: void 0, pct, amount: entry.amount, limit: entry.limit, resetTime: entry.resetTime });
			return segs;
		}

		/** 余额型数值文本。 */
		function rowValueText(entry) {
			if (entry.configured === false) return "未配置";
			if (entry.status !== "ok") return "—";
			return (entry.currency || "") + formatAmount(entry.amount);
		}

		/** 单行 tooltip（多行文本；quota 逐窗口一行）。 */
		function rowTitle(entry) {
			const label = providerLabel(entry.provider);
			if (entry.configured === false) return label + " 未配置 Key" + (entry.ref ? "（" + entry.ref + "）" : "");
			if (entry.status === "no_balance_api") return label + " 无余额接口";
			if (entry.status !== "ok") return label + " 余额查询失败";
			if (entry.kind === "quota") {
				const lines = [];
				for (const seg of quotaSegments(entry)) {
					let t = (seg.label ? seg.label + " " : "") + "剩余 " + seg.amount + "/" + seg.limit + (seg.pct === void 0 ? "" : "（" + seg.pct + "%）");
					if (typeof seg.resetTime === "string" && seg.resetTime.length > 0) t += " · 重置 " + seg.resetTime.slice(0, 10);
					lines.push(t);
				}
				const mem = membershipLabel(entry.membership);
				if (mem) lines.push("套餐等级 " + mem);
				return label + "\n" + lines.join("\n");
			}
			return label + " 余额 " + (entry.currency || "") + entry.amount;
		}

		/** 初始位置：会话头可见时挂在其下方，否则贴右上角。 */
		function defaultPos() {
			const header = document.querySelector("header");
			const headerVisible = !!header && getComputedStyle(header).display !== "none";
			const top = headerVisible ? 84 : 12;
			return { x: Math.max(window.innerWidth - CARD_MIN_WIDTH - 16, MARGIN), y: top };
		}

		function loadPos() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw) {
					const saved = JSON.parse(raw);
					if (typeof saved.x === "number" && typeof saved.y === "number") return { x: saved.x, y: saved.y };
				}
			} catch (err) { /* 忽略损坏的本地记录 */ }
			return defaultPos();
		}

		/** 渲染一行 provider 条目。 */
		function BalanceRow({ entry }) {
			const level = levelFor(entry);
			let valueEl;
			if (entry.kind === "quota") {
				const segs = quotaSegments(entry);
				const children = [];
				segs.forEach((seg, i) => {
					if (i > 0) children.push(react.createElement("span", { key: "sep" + i, className: "dsh-balance-sep" }, "·"));
					const segLevel = seg.pct === void 0 ? "gray" : levelForRatio(seg.pct / 100);
					children.push(react.createElement("span", { key: seg.key, className: "dsh-balance-seg lv-" + segLevel },
						seg.label ? react.createElement("span", { className: "dsh-balance-seg-label" }, seg.label + " ") : null,
						seg.pct === void 0 ? seg.amount + "/" + seg.limit : seg.pct + "%",
					));
				});
				valueEl = react.createElement("span", { className: "dsh-balance-value" }, children);
			} else {
				valueEl = react.createElement("span", { className: "dsh-balance-value lv-" + level }, rowValueText(entry));
			}
			return react.createElement("div", { className: "dsh-balance-row", title: rowTitle(entry) },
				react.createElement("span", { className: "dsh-balance-dot lv-" + level }),
				react.createElement("span", { className: "dsh-balance-name" }, providerLabel(entry.provider)),
				valueEl,
			);
		}

		/** 空态行（无会话模型 / 无可用余额接口 / 查询失败）。 */
		function EmptyRow({ text }) {
			return react.createElement("div", { className: "dsh-balance-row" },
				react.createElement("span", { className: "dsh-balance-dot lv-gray" }),
				react.createElement("span", { className: "dsh-balance-name" }, text),
				react.createElement("span", { className: "dsh-balance-value lv-gray" }, "—"),
			);
		}

		/** 跨会话聚合最近 provider：同 provider 取最大 usedAt，并稳定取前 3。 */
		function recentProvidersFromSnapshot(snapshot) {
			if (!snapshot || !Array.isArray(snapshot.ids)) return [];
			const byProvider = new Map();
			for (const id of snapshot.ids) {
				const entries = snapshot.byId && snapshot.byId[id] && snapshot.byId[id].projectionValues
					? snapshot.byId[id].projectionValues.llmBalanceRecentProviders
					: void 0;
				if (!Array.isArray(entries)) continue;
				for (const entry of entries) {
					if (!entry || typeof entry.provider !== "string" || !Number.isFinite(entry.usedAt)) continue;
					const previous = byProvider.get(entry.provider);
					if (previous === void 0 || entry.usedAt > previous) byProvider.set(entry.provider, entry.usedAt);
				}
			}
			return [...byProvider.entries()]
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
				.slice(0, MAX_RECENT_PROVIDERS)
				.map(([provider]) => provider);
		}

		function BalanceCard(props) {
			const refreshMs = props.refreshMs;
			const sessions = props.sessions;
			const [data, setData] = react.useState({ phase: "loading" });
			const [pos, setPos] = react.useState(loadPos);
			const [dragging, setDragging] = react.useState(false);
			const cardRef = react.useRef(null);
			const dragRef = react.useRef(null);
			const posRef = react.useRef(pos);
			const requestGeneration = react.useRef(0);
			const providerSignature = react.useRef("");
			posRef.current = pos;

			const recentProviders = react.useCallback(() => {
				if (!sessions) return [];
				const list = typeof sessions.list === "function" ? sessions.list() : sessions.list;
				const snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : void 0;
				return recentProvidersFromSnapshot(snapshot);
			}, [sessions]);

			const refresh = react.useCallback(() => {
				const generation = ++requestGeneration.current;
				const recent = recentProviders();
				providerSignature.current = recent.join("\0");
				if (recent.length === 0) {
					setData({ phase: "empty", recent });
					return;
				}
				fetch("/plugins/llm-balance?providers=" + encodeURIComponent(recent.join(",")), {
					cache: "no-store",
					signal: AbortSignal.timeout(15000),
				}).then((res) => {
					if (!res.ok) throw new Error("balance http " + res.status);
					return res.json();
				}).then((body) => {
					if (generation !== requestGeneration.current) return;
					const provs = body && Array.isArray(body.providers) ? body.providers : [];
					const anyConfigured = provs.some((p) => p && p.configured === true);
					if (provs.length === 0 || !anyConfigured) {
						setData({ phase: "hidden" });
						return;
					}
					// 按最近使用顺序取行（不足 3 个不硬凑：filter 后按实际行数渲染）。
					const rows = recent.map((name) => provs.find((p) => p && p.provider === name)).filter(Boolean);
					if (rows.length === 0) {
						setData({ phase: "empty", recent });
						return;
					}
					setData({ phase: "ok", rows });
				}).catch(() => { if (generation === requestGeneration.current) setData({ phase: "error" }); });
			}, [recentProviders]);

			react.useEffect(() => {
				let timer;
				let disposed = false;
				const schedule = () => {
					if (!disposed && !document.hidden) timer = setTimeout(tick, refreshMs);
				};
				const tick = () => { refresh(); schedule(); };
				const start = () => {
					clearTimeout(timer);
					if (!document.hidden) tick();
				};
				const onVisible = () => start();
				document.addEventListener("visibilitychange", onVisible);
				start();
				return () => {
					disposed = true;
					requestGeneration.current++;
					clearTimeout(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [refresh, refreshMs]);

			// 仅最近 provider 顺序变化时立即查询，其他列表更新不触发余额请求。
			react.useEffect(() => {
				if (!sessions || !sessions.list || typeof sessions.list.subscribe !== "function") return;
				return sessions.list.subscribe(() => {
					const signature = recentProviders().join("\0");
					if (signature !== providerSignature.current) refresh();
				});
			}, [sessions, recentProviders, refresh]);

			// 行数变化后校正位置（不写回 localStorage，拖动结束才写）。
			const rowCount = data.phase === "ok" ? data.rows.length : 1;
			react.useLayoutEffect(() => {
				const el = cardRef.current;
				if (!el) return;
				const w = el.offsetWidth;
				const h = el.offsetHeight;
				if (w <= 0 || h <= 0) return;
				setPos((p) => ({
					x: Math.min(Math.max(p.x, MARGIN), window.innerWidth - w - MARGIN),
					y: Math.min(Math.max(p.y, MARGIN), window.innerHeight - h - MARGIN),
				}));
			}, [rowCount]);

			function onPointerDown(e) {
				if (e.button !== 0 && e.pointerType === "mouse") return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
				setDragging(true);
			}

			function onPointerMove(e) {
				const d = dragRef.current;
				if (!d || e.pointerId !== d.id) return;
				const el = e.currentTarget;
				const w = el.offsetWidth;
				const h = el.offsetHeight;
				const dx = e.clientX - d.sx;
				const dy = e.clientY - d.sy;
				if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
				setPos({
					x: Math.min(Math.max(d.ox + dx, MARGIN), window.innerWidth - w - MARGIN),
					y: Math.min(Math.max(d.oy + dy, MARGIN), window.innerHeight - h - MARGIN),
				});
			}

			function endDrag(e) {
				const d = dragRef.current;
				if (!d || e.pointerId !== d.id) return;
				dragRef.current = null;
				setDragging(false);
				try { localStorage.setItem(STORAGE_KEY, JSON.stringify(posRef.current)); } catch (err) { /* 忽略 */ }
				if (!d.moved) refresh();
			}

			function onKeyDown(e) {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					refresh();
				}
			}

			if (data.phase === "hidden") return null;

			const cardProps = {
				ref: cardRef,
				className: "dsh-balance-card" + (dragging ? " dragging" : ""),
				style: { left: pos.x + "px", top: pos.y + "px" },
				role: "button",
				tabIndex: 0,
				"aria-label": "API 余额",
				onPointerDown: onPointerDown,
				onPointerMove: onPointerMove,
				onPointerUp: endDrag,
				onPointerCancel: endDrag,
				onKeyDown: onKeyDown,
			};

			if (data.phase === "ok") {
				return react.createElement("div", cardProps,
					data.rows.map((entry) => react.createElement(BalanceRow, { key: entry.provider, entry })),
				);
			}
			const emptyText = data.phase === "empty" && data.recent && data.recent.length > 0
				? "无可用余额接口"
				: data.phase === "error"
					? "余额查询失败"
					: "等待会话…";
			return react.createElement("div", cardProps, react.createElement(EmptyRow, { text: emptyText }));
		}

		const inject = ["sessions"];

		function apply(ctx, config) {
			const parsed = Number(config && config.refreshMs);
			const refreshMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
			// 注册到 ui-layout 声明的 shell.overlay 槽位（kind:list / scope:root 弹层容器）：
			// slots.inject 使注册跟随槽位声明生命周期，声明折叠/插件卸载自动 dispose。
			ctx.inject(["slots", "sessions"], (scope) => {
				scope.slots.inject("shell.overlay", () => scope.slots.register({
					name: "shell.overlay",
					id: "llm-balance",
					inject: () => ({ refreshMs, sessions: scope.sessions }),
				}, BalanceCard));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.recentProvidersFromSnapshot = recentProvidersFromSnapshot;
		return module.exports;
	}
});
