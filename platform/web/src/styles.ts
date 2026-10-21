// The overlay's stylesheet. It lives inside the overlay's shadow root, so the site's CSS can't reach in and ours can't
// leak out; `:host { all: initial }` also stops inherited styles (fonts, colors, line height) from crossing the
// boundary. Colors are tokens, redefined for dark mode.
export const OVERLAY_CSS = `
:host { all: initial; }
.panel {
  --bg: #ffffff; --bg-soft: #f5f6f8; --line: #e3e6eb; --text: #18202c; --muted: #5d6675; --accent: #1f5eff;
  --accent-soft: #e8efff; --user: #1f5eff; --user-text: #ffffff; --warn: #a14a00; --warn-soft: #fff3e6; --shadow: 0 8px 32px rgba(16, 24, 40, 0.18);
  box-sizing: border-box; position: fixed; top: 12px; right: 12px; bottom: 12px; width: 400px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; background: var(--bg); color: var(--text); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: var(--shadow); z-index: 2147483646; overflow: hidden;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel { --bg: #15181e; --bg-soft: #1d2129; --line: #2c323d; --text: #e8ebf0; --muted: #9aa3b2; --accent: #7aa2ff;
    --accent-soft: #1e2a47; --user: #3a6df0; --user-text: #ffffff; --warn: #ffb066; --warn-soft: #3a2a18; --shadow: 0 8px 32px rgba(0, 0, 0, 0.5); }
}
.panel[data-static] { position: static; width: 400px; max-width: none; height: auto; box-shadow: none; }
.panel[hidden] { display: none; }
.panel *, .panel *::before, .panel *::after { box-sizing: border-box; }
.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.head .title { font-weight: 600; flex: 1; }
.icon-btn { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); }
.icon-btn:hover { background: var(--bg-soft); color: var(--text); }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.panel[data-static] .log { overflow: visible; }
.empty { color: var(--muted); text-align: center; margin: auto 12px; }
.user { align-self: flex-end; max-width: 85%; background: var(--user); color: var(--user-text); padding: 8px 12px; border-radius: 14px 14px 4px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent { display: flex; flex-direction: column; gap: 10px; }
.text p { margin: 0 0 8px; }
.text p:last-child { margin-bottom: 0; }
.text ul { margin: 0 0 8px; padding-left: 18px; }
.progress { color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 8px; }
.progress .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
.panel[data-static] .progress .dot { animation: none; }
@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
.error { background: var(--warn-soft); color: var(--warn); padding: 8px 12px; border-radius: 10px; }
.budget { color: var(--muted); font-size: 12px; }
.heading { font-weight: 600; font-size: 13px; color: var(--muted); text-transform: none; margin: 2px 0 6px; }
.cards { display: flex; flex-direction: column; gap: 8px; }
.cards.carousel { flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 4px; }
.cards.carousel .card { flex: 0 0 240px; scroll-snap-align: start; }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--bg); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.card .t { font-weight: 600; }
.card .st { color: var(--muted); font-size: 13px; margin-top: -4px; }
.fields { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 13px; }
.fields dt { color: var(--muted); }
.fields dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.fields dd.na { color: var(--muted); font-style: italic; }
.est { color: var(--muted); font-size: 11px; margin-left: 4px; }
.link { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 500; align-self: flex-start; }
.link:hover { text-decoration: underline; }
.list .card { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 10px; padding: 8px 10px; }
.list .card .main { min-width: 0; }
.list .card .fields { display: block; text-align: right; }
.list .card .link { grid-column: 1; }
.list .card .fields dt { display: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { all: unset; cursor: pointer; border: 1px solid var(--line); background: var(--bg-soft); border-radius: 999px; padding: 5px 12px; font-size: 13px; }
.chip:hover { border-color: var(--accent); background: var(--accent-soft); }
.chip .st { color: var(--muted); margin-left: 6px; }
.compare { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
.compare table { border-collapse: collapse; font-size: 13px; min-width: 100%; }
.compare th, .compare td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; white-space: nowrap; }
.compare tr:last-child td { border-bottom: none; }
.compare th { font-weight: 600; background: var(--bg-soft); }
.compare td:first-child, .compare th:first-child { position: sticky; left: 0; background: var(--bg-soft); color: var(--muted); font-weight: 500; }
.compare td { font-variant-numeric: tabular-nums; }
.section { border-top: 1px solid var(--line); padding-top: 8px; }
.section .name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.section .name::first-letter { text-transform: uppercase; }
.section .summary { margin: 0 0 6px; font-size: 13px; }
.section ul { margin: 0; padding-left: 18px; font-size: 13px; }
.section .meta { color: var(--muted); }
.form { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.form label { display: flex; flex-direction: column; gap: 3px; font-size: 13px; color: var(--muted); }
.form input, .form select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.btn { all: unset; cursor: pointer; background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 14px; font-weight: 600; font-size: 13px; align-self: flex-start; }
.btn[disabled] { opacity: 0.5; cursor: default; }
.notice { font-size: 12px; color: var(--muted); background: var(--bg-soft); border-radius: 8px; padding: 6px 10px; }
.compose { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.compose textarea { flex: 1; resize: none; font: inherit; color: var(--text); background: var(--bg-soft); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; height: 40px; max-height: 120px; }
.compose textarea:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.launcher { all: unset; position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; cursor: pointer; background: #1f5eff; color: #fff;
  border-radius: 999px; padding: 10px 16px; font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 20px rgba(16, 24, 40, 0.25); }
.launcher[hidden] { display: none; }
`;
