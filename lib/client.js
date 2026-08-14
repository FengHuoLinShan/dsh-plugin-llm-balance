/**
 * dsh-plugin-llm-balance — client 半身（浏览器 bundle）。
 *
 * 渲染一个可拖动的 48px 悬浮球，固定在页面右上角起始，自动联动当前会话模型：
 *  - 通过 sessions.list 订阅当前会话，经 connection.api.sessions.models 取
 *    当前会话的 provider/model；
 *  - 轮询 GET /plugins/llm-balance（host 半身一次返回全部 provider 快照），
 *    按当前会话的 provider 挑选对应条目展示 —— 会话模型切换后自动跟随；
 *  - 余额型（deepseek / moonshot）按金额分档变色：
 *      绿 ≥ 100   黄 20~99   红 1~19   灰 <1 / 失败 / 加载中
 *    配额型（Kimi For Coding 套餐）按剩余比例分档：
 *      绿 ≥ 50%   黄 20~50%   红 5~20%   灰 <5% / 失败 / 加载中
 *  - 点击刷新，拖动记忆位置（localStorage），标签页隐藏时暂停轮询。
 *
 * 本文件即最终产物（经典脚本，由模块系统注入）：不依赖构建工具，
 * react / react-dom 由宿主模块表提供，无任何外部 import。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-llm-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_dom_client = require("react-dom/client");

		const STORAGE_KEY = "dsh-plugin-llm-balance.pos";
		const BALL_SIZE = 48;
		const MARGIN = 4;

		function levelFor(entry) {
			const n = Number(entry && entry.amount);
			if (!Number.isFinite(n)) return "gray";
			if (entry && entry.kind === "quota") {
				const limit = Number(entry.limit);
				if (!Number.isFinite(limit) || limit <= 0) return n > 0 ? "yellow" : "gray";
				const ratio = n / limit;
				if (ratio >= 0.5) return "green";
				if (ratio >= 0.2) return "yellow";
				if (ratio >= 0.05) return "red";
				return "gray";
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

		/** 初始位置：会话头可见时挂在其下方，否则贴右上角。 */
		function defaultPos() {
			const header = document.querySelector("header");
			const headerVisible = !!header && getComputedStyle(header).display !== "none";
			const top = headerVisible ? 84 : 12;
			return { x: Math.max(window.innerWidth - BALL_SIZE - 12, MARGIN), y: top };
		}

		function loadPos() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw) {
					const saved = JSON.parse(raw);
					if (typeof saved.x === "number" && typeof saved.y === "number") {
						return {
							x: Math.min(Math.max(saved.x, MARGIN), window.innerWidth - BALL_SIZE - MARGIN),
							y: Math.min(Math.max(saved.y, MARGIN), window.innerHeight - BALL_SIZE - MARGIN),
						};
					}
				}
			} catch (err) { /* 忽略损坏的本地记录 */ }
			return defaultPos();
		}

		function BalanceBall(props) {
			const refreshMs = props.refreshMs;
			const connection = props.connection;
			const sessions = props.sessions;
			const [data, setData] = react.useState({ phase: "loading" });
			const [pos, setPos] = react.useState(loadPos);
			const [dragging, setDragging] = react.useState(false);
			const dragRef = react.useRef(null);
			const posRef = react.useRef(pos);
			posRef.current = pos;
			const sessionRef = react.useRef({ sessionId: void 0, provider: void 0, model: void 0 });

			/** 读取当前会话的 provider/model（失败时保留上次已知值）。 */
			const refreshSessionModel = react.useCallback(() => {
				if (!sessions || !connection) return Promise.resolve();
				const list = typeof sessions.list === "function" ? sessions.list() : sessions.list;
				const snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : void 0;
				const sessionId = snapshot && snapshot.current ? snapshot.current : void 0;
				if (!sessionId) {
					sessionRef.current = { sessionId: void 0, provider: void 0, model: void 0 };
					return Promise.resolve();
				}
				return connection.api.sessions.models({ sessionId }).then((resp) => {
					const current = resp && resp.result && resp.result.current ? resp.result.current : void 0;
					sessionRef.current = {
						sessionId,
						provider: current ? current.provider : void 0,
						model: current ? current.model : void 0,
					};
				}).catch(() => { /* 保留上次已知会话 */ });
			}, [connection, sessions]);

			const refresh = react.useCallback(() => {
				let cancelled = false;
				refreshSessionModel().catch(() => {});
				fetch("/plugins/llm-balance", { cache: "no-store", signal: AbortSignal.timeout(15000) })
					.then((res) => res.json())
					.then((body) => {
						if (cancelled) return;
						const provs = body && Array.isArray(body.providers) ? body.providers : [];
						const anyConfigured = provs.some((p) => p && p.configured === true);
						if (provs.length === 0 || !anyConfigured) {
							setData({ phase: "hidden" });
							return;
						}
						const s = sessionRef.current;
						const entry = s.provider ? provs.find((p) => p && p.provider === s.provider) : void 0;
						const base = { sessionProvider: s.provider, sessionModel: s.model };
						if (!entry) {
							setData({ phase: "unknown", ...base });
						} else if (entry.configured === false) {
							setData({ phase: "unconfigured", entry, ...base });
						} else if (entry.status === "ok") {
							setData({ phase: "ok", entry, ...base });
						} else if (entry.status === "no_balance_api") {
							setData({ phase: "noBalance", entry, ...base });
						} else {
							setData({ phase: "error", entry, ...base });
						}
					})
					.catch(() => { if (!cancelled) setData({ phase: "error" }); });
				return () => { cancelled = true; };
			}, [refreshSessionModel]);

			react.useEffect(() => {
				refresh();
				const timer = setInterval(refresh, refreshMs);
				const onVisible = () => { if (!document.hidden) refresh(); };
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [refresh, refreshMs]);

			// 会话切换（新会话 / 会话模型变化）→ 立即刷新，不等下一个轮询周期。
			react.useEffect(() => {
				if (!sessions || !sessions.list || typeof sessions.list.subscribe !== "function") return;
				return sessions.list.subscribe(() => refresh());
			}, [sessions, refresh]);

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
				const dx = e.clientX - d.sx;
				const dy = e.clientY - d.sy;
				if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
				setPos({
					x: Math.min(Math.max(d.ox + dx, MARGIN), window.innerWidth - BALL_SIZE - MARGIN),
					y: Math.min(Math.max(d.oy + dy, MARGIN), window.innerHeight - BALL_SIZE - MARGIN),
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

			let level = "gray";
			let text = "…";
			let title = "正在查询 API 余额…";
			if (data.phase === "ok") {
				const entry = data.entry;
				level = levelFor(entry);
				text = formatAmount(entry.amount);
				const model = data.sessionModel ? " · 会话模型 " + data.sessionModel : "";
				if (entry.kind === "quota") {
					const mem = membershipLabel(entry.membership);
					title = providerLabel(entry.provider) + " 套餐剩余 " + entry.amount + "/" + entry.limit
						+ (mem ? " · " + mem : "") + model + " · 点击刷新，拖动调整位置";
				} else {
					title = providerLabel(entry.provider) + " 余额 " + (entry.currency || "") + entry.amount
						+ model + " · 点击刷新，拖动调整位置";
				}
			} else if (data.phase === "noBalance") {
				text = "—";
				title = providerLabel(data.entry.provider) + " 无余额接口 · 会话模型 " + (data.sessionModel || "?") + " · 点击刷新";
			} else if (data.phase === "unconfigured") {
				text = "—";
				title = providerLabel(data.entry.provider) + " 未配置 Key" + (data.entry.ref ? "（" + data.entry.ref + "）" : "") + " · 点击刷新";
			} else if (data.phase === "unknown") {
				text = "—";
				title = data.sessionProvider
					? providerLabel(data.sessionProvider) + " 暂无可查余额接口 · 会话模型 " + (data.sessionModel || "?") + " · 点击刷新"
					: "等待会话…";
			} else if (data.phase === "error") {
				text = "—";
				title = "余额查询失败" + (data.entry ? " · " + providerLabel(data.entry.provider) : "") + " · 点击重试";
			}

			return react.createElement("button", {
				type: "button",
				className: "dsh-balance-ball lv-" + level + (dragging ? " dragging" : ""),
				style: { left: pos.x + "px", top: pos.y + "px" },
				title: title,
				"aria-label": "API 余额 " + text,
				onPointerDown: onPointerDown,
				onPointerMove: onPointerMove,
				onPointerUp: endDrag,
				onPointerCancel: endDrag,
				onKeyDown: onKeyDown,
			}, text);
		}

		const inject = ["connection", "sessions"];

		function apply(ctx, config) {
			const parsed = Number(config && config.refreshMs);
			const refreshMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-balance-plugin-style", "");
				style.textContent = [
					".dsh-balance-ball{position:fixed;width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:#64748b;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;font-weight:600;line-height:1;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;z-index:30;box-shadow:0 4px 14px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.16);transition:box-shadow .15s}",
					".dsh-balance-ball:hover{box-shadow:0 6px 18px rgba(0,0,0,.45)}",
					".dsh-balance-ball.dragging{cursor:grabbing;box-shadow:0 8px 22px rgba(0,0,0,.5)}",
					".dsh-balance-ball.lv-green{background:#22c55e}",
					".dsh-balance-ball.lv-yellow{background:#eab308;color:#1f2937}",
					".dsh-balance-ball.lv-red{background:#ef4444}",
					".dsh-balance-ball.lv-gray{background:#64748b}",
				].join("\n");
				document.head.appendChild(style);

				const host = document.createElement("div");
				host.setAttribute("data-dsh-plugin", "llm-balance");
				document.body.appendChild(host);
				const root = react_dom_client.createRoot(host);
				root.render(react.createElement(BalanceBall, {
					refreshMs: refreshMs,
					connection: ctx.get("connection"),
					sessions: ctx.get("sessions"),
				}));

				return () => {
					root.unmount();
					host.remove();
					style.remove();
				};
			}, "llm-balance: floating ball");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
