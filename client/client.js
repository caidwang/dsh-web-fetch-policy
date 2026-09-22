window.__ModuleLoader__.load({
	id: "dsh-web-fetch-policy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client.ts
		/** Browser card for configuring private-network fetch exceptions. */
		const NAMESPACE = "web-fetch-policy";
		/** Loader-visible browser plugin name. */
		const name = "web-fetch-policy";
		/** DSH client services required by the settings card. */
		const inject = ["slots"];
		/** Register this plugin's card in Settings → Plugins. */
		function apply(ctx) {
			ctx.inject(["settingsScope"], (scoped) => {
				const scope = scoped.settingsScope.bind({ namespace: NAMESPACE });
				scoped.slots.inject("settings.plugin.item", () => scoped.slots.register({
					name: "settings.plugin.item",
					key: NAMESPACE
				}, () => (0, react.createElement)(PolicyCard, { scope })));
			});
		}
		/** Render and persist the policy fields that control non-public destinations. */
		function PolicyCard({ scope }) {
			const snapshot = (0, react.useSyncExternalStore)(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope));
			const [cidrs, setCidrs] = (0, react.useState)(join(snapshot.value?.allowedPrivateCidrs ?? []));
			const [hosts, setHosts] = (0, react.useState)(join(snapshot.value?.allowedPrivateHosts ?? []));
			const [privateDns, setPrivateDns] = (0, react.useState)(snapshot.value?.allowPrivateDns ?? false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (snapshot.value === void 0) return;
				setCidrs(join(snapshot.value.allowedPrivateCidrs));
				setHosts(join(snapshot.value.allowedPrivateHosts));
				setPrivateDns(snapshot.value.allowPrivateDns);
			}, [snapshot.value]);
			const save = async () => {
				setSaving(true);
				setError(void 0);
				try {
					await scope.set("allowedPrivateCidrs", lines(cidrs));
					await scope.set("allowedPrivateHosts", lines(hosts));
					await scope.set("allowPrivateDns", privateDns);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSaving(false);
				}
			};
			if (snapshot.status !== "ready") return (0, react.createElement)("li", { style: card }, "Loading web fetch network policy…");
			const disabled = !snapshot.writable || saving;
			return (0, react.createElement)("li", { style: card }, (0, react.createElement)("h3", { style: { margin: 0 } }, "Web fetch network policy"), (0, react.createElement)("p", { style: hint }, "Configure explicit non-public network exceptions. Changes apply to new web fetch requests."), field("Allowed CIDRs", cidrs, setCidrs, "One canonical CIDR per line. TUN Fake-IP example: 198.18.0.0/16."), field("Allowed hosts", hosts, setHosts, "One exact hostname or IP literal per line."), (0, react.createElement)("label", { style: row }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: privateDns,
				disabled,
				onChange: (event) => setPrivateDns(event.currentTarget.checked)
			}), " Allow listed DNS names to resolve to private addresses"), error === void 0 ? null : (0, react.createElement)("p", { style: {
				...hint,
				color: "var(--dsw-alias-label-error)"
			} }, error), (0, react.createElement)("button", {
				type: "button",
				disabled,
				onClick: () => {
					save();
				},
				style: button
			}, saving ? "Saving…" : "Save"));
		}
		/** Render one line-oriented allowlist field. */
		function field(label, value, update, description) {
			return (0, react.createElement)("label", { style: fieldStyle }, label, (0, react.createElement)("textarea", {
				rows: 3,
				value,
				onChange: (event) => update(event.currentTarget.value),
				style: input
			}), (0, react.createElement)("span", { style: hint }, description));
		}
		/** Convert the editor's line-oriented value into the settings array. */
		function lines(value) {
			return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
		}
		/** Render one allowlist as one entry per line. */
		function join(value) {
			return value.join("\n");
		}
		const card = {
			listStyle: "none",
			border: "1px solid var(--dsw-alias-border-l4)",
			borderRadius: "12px",
			padding: "16px",
			display: "grid",
			gap: "12px"
		};
		const fieldStyle = {
			display: "grid",
			gap: "6px",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "13px"
		};
		const row = {
			display: "flex",
			gap: "8px",
			alignItems: "center",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "13px"
		};
		const input = {
			width: "100%",
			boxSizing: "border-box",
			border: "1px solid var(--dsw-alias-border-l4)",
			borderRadius: "6px",
			padding: "8px",
			font: "inherit",
			color: "var(--dsw-alias-label-primary)",
			background: "var(--dsw-alias-bg-layer-3)"
		};
		const hint = {
			margin: 0,
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			lineHeight: 1.5
		};
		const button = {
			justifySelf: "start",
			border: 0,
			borderRadius: "6px",
			padding: "7px 14px",
			color: "var(--dsw-alias-bg-layer-3)",
			background: "var(--dsw-alias-label-primary)",
			cursor: "pointer"
		};
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map