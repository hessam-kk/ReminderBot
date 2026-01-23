"use strict";

/* ── tiny helpers ─────────────────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2400);
}

/* ── state ────────────────────────────────────────────────────────────────── */
const state = {
  meta: { intervals: [], tzPresets: [], startOptions: [] },
  me: null,
  tz: "Asia/Tehran",
  reminders: [],
  stats: null,
};

/* ── formatting ───────────────────────────────────────────────────────────── */
function pad(n) { return String(n).padStart(2, "0"); }

function fmtNext(tz, epochSec, nowSec) {
  const d = new Date(epochSec * 1000);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d);
  const dayA = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(nowSec * 1000));
  const dayB = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d);
  const diff = Math.round((Date.parse(dayB) - Date.parse(dayA)) / 86400000);
  if (diff <= 0) return `today ${hm}`;
  if (diff === 1) return `tomorrow ${hm}`;
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })
    .format(d);
  return `${label} ${hm}`;
}

function intervalLabel(days) {
  const p = state.meta.intervals.find((i) => i.days === days);
  return p ? p.label.toLowerCase() : `every ${days} days`;
}

/* ── auth view ────────────────────────────────────────────────────────────── */
function setupAuth() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.toggle("active", x === t));
      const mode = t.dataset.tab;
      const isTg = mode === "telegram";
      $("#auth-submit").textContent = isTg ? "Log in with code" : mode === "login" ? "Log in" : "Create account";
      $("#auth-credentials").classList.toggle("hidden", isTg);
      $("#auth-code-field").classList.toggle("hidden", !isTg);
      $("#auth-note").classList.toggle("hidden", mode !== "login" || isTg);
      $("#auth-telegram-note").classList.toggle("hidden", !isTg);
      $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
      $("#auth-error").classList.add("hidden");
    })
  );

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = document.querySelector(".tab.active").dataset.tab;
    const errEl = $("#auth-error");
    errEl.classList.add("hidden");
    $("#auth-submit").disabled = true;
    try {
      if (mode === "telegram") {
        const code = $("#auth-code").value.trim().toUpperCase();
        if (!/^[A-F0-9]{8}$/.test(code)) throw new Error("Enter the 8-character code from the bot.");
        await api("/api/login-code", { method: "POST", body: JSON.stringify({ code }) });
      } else {
        const username = $("#auth-username").value.trim();
        const password = $("#auth-password").value;
        if (!username || !password) throw new Error("Enter your username and password.");
        if (mode === "login") await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
        else await api("/api/register", { method: "POST", body: JSON.stringify({ username, password }) });
      }
      await enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    } finally {
      $("#auth-submit").disabled = false;
    }
  });
}

/* ── app view ─────────────────────────────────────────────────────────────── */
async function enterApp() {
  const [me, meta] = await Promise.all([api("/api/me"), api("/api/meta")]);
  state.me = me;
  state.tz = me.timezone;
  state.meta = meta;
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#brand-user").textContent = `Signed in as ${esc(me.username)}`;
  buildTzSelect();
  await refresh();
}

function buildTzSelect() {
  const sel = $("#tz-select");
  sel.innerHTML = "";
  for (const p of state.meta.tzPresets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  sel.value = state.tz;
  sel.addEventListener("change", async () => {
    try {
      const r = await api("/api/timezone", { method: "POST", body: JSON.stringify({ timezone: sel.value }) });
      state.tz = r.timezone;
      toast(`🌍 ${r.timezone}`);
      await refresh();
    } catch (err) { toast(err.message); }
  });
}

async function refresh() {
  const [list, stats, me] = await Promise.all([api("/api/reminders"), api("/api/stats"), api("/api/me")]);
  state.reminders = list.reminders;
  state.stats = stats;
  state.tz = me.timezone;
  state.me = me;
  renderStats();
  renderList();
  renderLinkState();
}

/* ── Telegram linking ─────────────────────────────────────────────────────── */
let linkPoll = null;

function renderLinkState() {
  const linked = state.me && state.me.linked;
  $("#link-banner").classList.toggle("hidden", !!linked);
  const pill = $("#linked-pill");
  pill.classList.toggle("hidden", !linked);
  pill.textContent = linked && state.me.telegramUsername ? `🔗 @${state.me.telegramUsername}` : "🔗 Connected to Telegram";
}

async function startLinkFlow() {
  let data;
  try {
    data = await api("/api/link", { method: "POST" });
  } catch (err) {
    toast(err.message);
    return;
  }
  $("#link-code").textContent = data.code;
  $("#link-status").textContent = "Waiting for the code to be used…";
  $("#link-modal-backdrop").classList.remove("hidden");

  clearInterval(linkPoll);
  const started = Date.now();
  linkPoll = setInterval(async () => {
    try {
      const me = await api("/api/me");
      if (me.linked) {
        clearInterval(linkPoll);
        $("#link-modal-backdrop").classList.add("hidden");
        toast("🔗 Connected! Bot and web now share one list");
        await refresh();
        return;
      }
    } catch { /* keep polling */ }
    if (Date.now() - started > 90 * 1000) {
      clearInterval(linkPoll);
      $("#link-status").textContent = "Still waiting — you can close this and press ⟳ once you've sent the code.";
    }
  }, 3000);
}

function closeLinkModal() {
  clearInterval(linkPoll);
  $("#link-modal-backdrop").classList.add("hidden");
}

function renderStats() {
  $("#stat-active").textContent = state.stats.activeCount;
  $("#stat-total").textContent = state.stats.totalCount;
  $("#stat-done").textContent = state.stats.totalDone;
  $("#stat-best").textContent = state.stats.bestStreak;
}

function renderList() {
  const list = $("#list");
  list.innerHTML = "";
  const empty = $("#empty-note");
  empty.classList.toggle("hidden", state.reminders.length > 0);
  if (state.reminders.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  for (const r of state.reminders) {
    const card = document.createElement("div");
    card.className = "reminder" + (r.dueNow ? " due" : "") + (r.active ? "" : " paused");

    const badge = r.dueNow
      ? '<span class="reminder-badge badge-due">DUE NOW</span>'
      : r.active
      ? ""
      : '<span class="reminder-badge badge-paused">PAUSED</span>';

    const next = r.dueNow
      ? '<span class="next">🔴 due now</span>'
      : `<span class="next">🔔 ${esc(fmtNext(state.tz, r.nextDue, now))}</span>`;

    const streak = r.streak > 0 ? ` · 🔥 ${r.streak}${r.bestStreak > r.streak ? ` (best ${r.bestStreak})` : ""}` : "";

    const actions = `
      <button class="btn btn-sm" data-act="done" data-id="${r.id}">✅ Done</button>
      <button class="btn btn-sm btn-ghost" data-act="snooze1h" data-id="${r.id}">⏰ +1h</button>
      <button class="btn btn-sm btn-ghost" data-act="snooze1d" data-id="${r.id}">⏰ +1d</button>
      <button class="btn btn-sm btn-ghost" data-act="pause" data-id="${r.id}">${r.active ? "⏸ Pause" : "▶️ Resume"}</button>
      <button class="btn btn-sm btn-ghost" data-act="interval" data-id="${r.id}">✏️ Interval</button>
      <button class="btn btn-sm btn-ghost danger" data-act="delete" data-id="${r.id}">🗑 Delete</button>`;

    card.innerHTML = `
      <div class="reminder-head">
        <span class="reminder-title">${esc(r.title)}</span>
        ${badge}
      </div>
      <div class="reminder-meta">
        <span>⏱ ${esc(intervalLabel(r.intervalDays))} at ${pad(r.hour)}:${pad(r.minute)}</span>
        <span>${next}</span>
        <span>${streak}</span>
      </div>
      <div class="reminder-actions">${actions}</div>`;

    list.appendChild(card);
  }
}

async function onAction(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  btn.disabled = true;
  try {
    if (act === "done") {
      const r = await api(`/api/reminders/${id}/done`, { method: "POST" });
      toast(`🎉 Done! Streak ${r.streak}`);
    } else if (act === "snooze1h" || act === "snooze1d") {
      await api(`/api/reminders/${id}/snooze`, { method: "POST", body: JSON.stringify({ seconds: act === "snooze1d" ? 86400 : 3600 }) });
      toast(`⏰ Snoozed ${act === "snooze1d" ? "1 day" : "1 hour"}`);
    } else if (act === "pause") {
      const r = await api(`/api/reminders/${id}/pause`, { method: "POST" });
      toast(r.active ? "▶️ Resumed" : "⏸ Paused");
    } else if (act === "interval") {
      openIntervalModal(id);
      btn.disabled = false;
      return;
    } else if (act === "delete") {
      if (!confirm("Delete this reminder? This cannot be undone.")) { btn.disabled = false; return; }
      await api(`/api/reminders/${id}`, { method: "DELETE" });
      toast("🗑 Deleted");
    }
    await refresh();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

/* ── modal: add & edit interval ───────────────────────────────────────────── */
let editingId = null;

function chipGroup(container, options, onChange, valueKey, value) {
  container.innerHTML = "";
  for (const o of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (o[valueKey] === value ? " active" : "");
    b.textContent = o.label;
    b.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      onChange(o[valueKey]);
    });
    container.appendChild(b);
  }
}

function openAddModal() {
  editingId = null;
  $("#modal-title").textContent = "New reminder";
  $("#modal-save").textContent = "Save reminder";
  $("#f-title").value = "";
  $("#f-title").disabled = false;
  $("#f-title").focus();
  initModalDefaults();
  showModal();
}

function openIntervalModal(id) {
  editingId = id;
  $("#modal-title").textContent = "Edit interval";
  $("#modal-save").textContent = "Update interval";
  $("#f-title").disabled = true;
  $("#f-title").value = "";
  // hide title, start & time groups in interval-edit mode (keep interval)
  $("#f-title").closest(".field").style.display = "none";
  document.querySelectorAll("#modal-form .field")[2].style.display = "none"; // start group
  document.querySelectorAll("#modal-form .field")[3].style.display = "none"; // time group
  initIntervalChips(0);
  showModal();
}

function showModal() {
  $("#modal-backdrop").classList.remove("hidden");
  $("#modal-error").classList.add("hidden");
}

function hideModal() {
  $("#modal-backdrop").classList.add("hidden");
  editingId = null;
  $("#f-title").closest(".field").style.display = "";
  document.querySelectorAll("#modal-form .field")[1].style.display = "";
  document.querySelectorAll("#modal-form .field")[2].style.display = "";
  document.querySelectorAll("#modal-form .field")[3].style.display = "";
}

function initModalDefaults() {
  initIntervalChips(0);
  initStartChips(0);
  initTimeChips("09:00");
  // reset custom inputs
  $("#f-interval-custom").value = "";
  $("#f-start-custom").value = "";
  $("#f-time-custom").value = "";
}

const modalVals = { interval: null, start: null, time: null };

function initIntervalChips(active) {
  modalVals.interval = active;
  chipGroup($("#f-interval-chips"), state.meta.intervals, (v) => { modalVals.interval = v; }, "days", active);
  $("#f-interval-custom").value = "";
}

function initStartChips(active) {
  modalVals.start = active;
  chipGroup($("#f-start-chips"), state.meta.startOptions, (v) => { modalVals.start = v; }, "offset", active);
  $("#f-start-custom").value = "";
}

const TIME_PRESETS = ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00", "23:00"];

function initTimeChips(active) {
  modalVals.time = active;
  chipGroup($("#f-time-chips"), TIME_PRESETS.map((t) => ({ label: t, time: t })), (v) => { modalVals.time = v; }, "time", active);
  $("#f-time-custom").value = "";
}

$("#f-interval-custom").addEventListener("input", () => {
  const n = parseInt($("#f-interval-custom").value, 10);
  if (n >= 1 && n <= 3650) {
    modalVals.interval = n;
    $("#f-interval-chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  }
});

$("#f-start-custom").addEventListener("input", () => {
  const n = parseInt($("#f-start-custom").value, 10);
  if (n >= 0 && n <= 5000) {
    modalVals.start = n;
    $("#f-start-chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  }
});

$("#f-time-custom").addEventListener("input", () => {
  const v = $("#f-time-custom").value;
  if (/^\d{2}:\d{2}$/.test(v)) {
    modalVals.time = v;
    $("#f-time-chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  }
});

$("#modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#modal-error");
  errEl.classList.add("hidden");
  $("#modal-save").disabled = true;
  try {
    if (editingId) {
      if (modalVals.interval === null) throw new Error("Pick an interval.");
      await api(`/api/reminders/${editingId}/interval`, { method: "POST", body: JSON.stringify({ days: modalVals.interval }) });
      toast("✅ Interval updated");
    } else {
      const title = $("#f-title").value.trim();
      if (!title) throw new Error("Give your reminder a name.");
      if (modalVals.interval === null) throw new Error("Pick how often.");
      if (modalVals.start === null) modalVals.start = 0;
      if (modalVals.time === null) throw new Error("Pick a time.");
      const [h, m] = modalVals.time.split(":").map(Number);
      const r = await api("/api/reminders", {
        method: "POST",
        body: JSON.stringify({
          title,
          intervalDays: modalVals.interval,
          hour: h,
          minute: m,
          offsetDays: modalVals.start,
        }),
      });
      toast("✅ Reminder added");
    }
    hideModal();
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  } finally {
    $("#modal-save").disabled = false;
  }
});

/* ── boot ─────────────────────────────────────────────────────────────────── */
$("#link-btn").addEventListener("click", startLinkFlow);
$("#link-modal-close").addEventListener("click", closeLinkModal);
$("#link-cancel").addEventListener("click", closeLinkModal);
$("#link-modal-backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeLinkModal(); });
$("#add-btn").addEventListener("click", openAddModal);
$("#modal-close").addEventListener("click", hideModal);
$("#modal-cancel").addEventListener("click", hideModal);
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) hideModal(); });
$("#refresh-btn").addEventListener("click", () => refresh().then(() => toast("⟳ Refreshed")));
$("#logout-btn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch { /* ignore */ }
  location.reload();
});
$("#list").addEventListener("click", onAction);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) hideModal(); });

setupAuth();

(async () => {
  try {
    await api("/api/me");
    await enterApp();
  } catch {
    $("#auth-view").classList.remove("hidden");
  }
})();
