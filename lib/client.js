/**
 * dsh-plugin-llm-balance — client 半身（浏览器 bundle）。
 *
 * 渲染一个可拖动的 48px 悬浮球，固定在页面右上角起始，按余额分档变色：
 *   绿色  ≥ 100         黄色  20 ~ 99
 *   红色  1 ~ 19        灰色  < 1（余额不足）或查询失败/加载中
 * 轮询 GET /plugins/llm-balance（host 半身提供），点击刷新，拖动记忆位置
 * （localStorage），标签页隐藏时暂停轮询。
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

		function levelFor(amount) {
			const n = Number(amount);
			if (!Number.isFinite(n)) return "gray";
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
			if (provider === "deepseek") return "DeepSeek";
			if (provider === "kimi") return "Kimi";
			return provider || "API";
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
			const [data, setData] = react.useState({ phase: "loading" });
			const [pos, setPos] = react.useState(loadPos);
			const [dragging, setDragging] = react.useState(false);
			const dragRef = react.useRef(null);
			const posRef = react.useRef(pos);
			posRef.current = pos;

			const refresh = react.useCallback(() => {
				let cancelled = false;
				fetch("/plugins/llm-balance", { cache: "no-store", signal: AbortSignal.timeout(15000) })
					.then((res) => res.json())
					.then((body) => {
						if (cancelled) return;
						if (!body || body.configured === false) setData({ phase: "hidden" });
						else if (body.status === "ok") {
							setData({
								phase: "ok",
								amount: body.amount,
								currency: body.currency,
								provider: body.provider,
								queriedAt: body.queriedAt,
							});
						} else {
							setData({ phase: "error", provider: body.provider });
						}
					})
					.catch(() => { if (!cancelled) setData({ phase: "error" }); });
				return () => { cancelled = true; };
			}, []);

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

			const level = data.phase === "ok" ? levelFor(data.amount) : "gray";
			const text = data.phase === "loading" ? "…" : data.phase === "error" ? "—" : formatAmount(data.amount);
			let title;
			if (data.phase === "ok") {
				title = providerLabel(data.provider) + " 余额 " + (data.currency || "") + data.amount
					+ " · 点击刷新，拖动调整位置";
			} else if (data.phase === "error") {
				title = "余额查询失败 · 点击重试";
			} else {
				title = "正在查询 API 余额…";
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

		const inject = [];

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
				root.render(react.createElement(BalanceBall, { refreshMs: refreshMs }));

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
