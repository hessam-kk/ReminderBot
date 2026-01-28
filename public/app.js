"use strict";

/* ── theme (light / dark / system) ────────────────────────────────────────── */
const THEME_KEY = "rb-theme";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return themeMedia.matches ? "dark" : "light";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  } else {
    // "system": clear the override and follow the OS preference
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = $("#theme-btn");
  if (btn) btn.innerHTML = effectiveTheme() === "dark" ? icon("sun") : icon("moon");
}

// Keep the icon in sync when the OS theme changes (unless the user overrode it)
themeMedia.addEventListener("change", () => {
  if (!localStorage.getItem(THEME_KEY)) updateThemeIcon();
});

/* ── svg icons ────────────────────────────────────────────────────────────── */
const ICONS = {
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>',
  sun: '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
  refresh: '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
  check: '<polyline points="20 6 9 17 4 12"></polyline>',
  clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
  pause: '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>',
  play: '<polygon points="5 3 19 12 5 21 5 3"></polygon>',
  pencil: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>',
  trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

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
  listTab: "upcoming", // "upcoming" | "today"
};

/* ── formatting ───────────────────────────────────────────────────────────── */
function pad(n) { return String(n).padStart(2, "0"); }

// Calendar-day difference (in the user's timezone) between an epoch and now.
// <= 0 means due today or overdue; 1 = tomorrow; etc.
function dayDiff(tz, epochSec, nowSec) {
  const day = (ms) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return Math.round((Date.parse(day(epochSec * 1000)) - Date.parse(day(nowSec * 1000))) / 86400000);
}

function fmtNext(tz, epochSec, nowSec) {
  const d = new Date(epochSec * 1000);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d);
  const diff = dayDiff(tz, epochSec, nowSec);
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
  const tabs = $("#list-tabs");

  if (state.reminders.length === 0) {
    tabs.classList.add("hidden");
    empty.textContent = "No reminders yet. Tap ＋ New reminder to add your first one — it works exactly like the Telegram bot.";
    empty.classList.remove("hidden");
    return;
  }
  tabs.classList.remove("hidden");
  empty.classList.add("hidden");

  const now = Math.floor(Date.now() / 1000);
  const today = [];
  const upcoming = [];
  for (const r of state.reminders) {
    (dayDiff(state.tz, r.nextDue, now) <= 0 ? today : upcoming).push(r);
  }
  $("#count-today").textContent = today.length;
  $("#count-upcoming").textContent = upcoming.length;

  const items = state.listTab === "today" ? today : upcoming;
  if (items.length === 0) {
    empty.textContent =
      state.listTab === "today"
        ? "Nothing due today or overdue. 🎉"
        : "No upcoming reminders — add one with ＋ New reminder.";
    empty.classList.remove("hidden");
    return;
  }

  for (const r of items) {
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
      <button class="btn btn-sm" data-act="done" data-id="${r.id}" data-tip="Mark as done and schedule the next one">${icon("check")} Done</button>
      <button class="btn btn-sm btn-ghost" data-act="snooze1h" data-id="${r.id}" data-tip="Snooze for 1 hour">${icon("clock")} +1h</button>
      <button class="btn btn-sm btn-ghost" data-act="snooze1d" data-id="${r.id}" data-tip="Snooze for 1 day">${icon("clock")} +1d</button>
      <button class="btn btn-sm btn-ghost" data-act="pause" data-id="${r.id}" data-tip="${r.active ? "Pause this reminder" : "Resume this reminder"}">${icon(r.active ? "pause" : "play")} ${r.active ? "Pause" : "Resume"}</button>
      <button class="btn btn-sm btn-ghost" data-act="interval" data-id="${r.id}" data-tip="Change how often this repeats">${icon("pencil")} Interval</button>
      <button class="btn btn-sm btn-ghost danger" data-act="delete" data-id="${r.id}" data-tip="Delete this reminder forever">${icon("trash")} Delete</button>`;

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

function setListTab(tab) {
  state.listTab = tab;
  document.querySelectorAll(".ltab").forEach((b) => b.classList.toggle("active", b.dataset.ltab === tab));
  renderList();
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

function chipGroup(container, options, onChange, valueKey, value, custom) {
  container.innerHTML = "";
  for (const o of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (o[valueKey] === value ? " active" : "");
    b.textContent = o.label;
    if (o.tip) b.dataset.tip = o.tip;
    b.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      onChange(o[valueKey]);
    });
    container.appendChild(b);
  }
  if (custom) {
    const cb = document.createElement("button");
    cb.type = "button";
    cb.className = "chip chip-custom";
    cb.textContent = custom.label;
    cb.addEventListener("click", () => {
      container.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      cb.classList.add("active");
      custom.onCustom();
    });
    container.appendChild(cb);
  }
}

function showCustom(row, input) {
  row.classList.remove("hidden");
  input.focus();
}

function hideCustom(row, input) {
  row.classList.add("hidden");
  input.value = "";
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
  const row = $("#f-interval-custom").closest(".custom-row");
  hideCustom(row, $("#f-interval-custom"));
  chipGroup(
    $("#f-interval-chips"),
    state.meta.intervals.map((i) => ({ ...i, tip: `Repeats ${i.label.toLowerCase()}` })),
    (v) => { modalVals.interval = v; hideCustom(row, $("#f-interval-custom")); },
    "days",
    active,
    { label: "✏️ Custom…", onCustom: () => { modalVals.interval = null; showCustom(row, $("#f-interval-custom")); } }
  );
}

function initStartChips(active) {
  modalVals.start = active;
  const row = $("#f-start-custom").closest(".custom-row");
  hideCustom(row, $("#f-start-custom"));
  chipGroup(
    $("#f-start-chips"),
    state.meta.startOptions.map((o) => ({
      ...o,
      tip: o.offset === 0 ? "Start the cycle today" : `Cycle started ${o.label.toLowerCase()}`,
    })),
    (v) => { modalVals.start = v; hideCustom(row, $("#f-start-custom")); },
    "offset",
    active,
    { label: "✏️ Custom…", onCustom: () => { modalVals.start = null; showCustom(row, $("#f-start-custom")); } }
  );
}

const TIME_PRESETS = ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00", "23:00"];

function initTimeChips(active) {
  modalVals.time = active;
  const row = $("#f-time-custom").closest(".custom-row");
  hideCustom(row, $("#f-time-custom"));
  chipGroup(
    $("#f-time-chips"),
    TIME_PRESETS.map((t) => ({ label: t, time: t, tip: `Fires at ${t}` })),
    (v) => { modalVals.time = v; hideCustom(row, $("#f-time-custom")); },
    "time",
    active,
    { label: "✏️ Custom…", onCustom: () => { modalVals.time = null; showCustom(row, $("#f-time-custom")); } }
  );
}

$("#f-interval-custom").addEventListener("input", () => {
  const n = parseInt($("#f-interval-custom").value, 10);
  const chips = $("#f-interval-chips");
  if (n >= 1 && n <= 3650) {
    modalVals.interval = n;
    chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chips.querySelector(".chip-custom")?.classList.add("active");
  }
});

$("#f-start-custom").addEventListener("input", () => {
  const n = parseInt($("#f-start-custom").value, 10);
  const chips = $("#f-start-chips");
  if (n >= 0 && n <= 5000) {
    modalVals.start = n;
    chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chips.querySelector(".chip-custom")?.classList.add("active");
  }
});

$("#f-time-custom").addEventListener("input", () => {
  const v = $("#f-time-custom").value;
  const chips = $("#f-time-chips");
  if (/^\d{2}:\d{2}$/.test(v)) {
    modalVals.time = v;
    chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chips.querySelector(".chip-custom")?.classList.add("active");
  }
});

$("#modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#modal-error");
  errEl.classList.add("hidden");
  $("#modal-save").disabled = true;
  try {
    const customOpen = (id) => !$(id).closest(".custom-row").classList.contains("hidden");
    if (editingId) {
      if (modalVals.interval === null) {
        throw new Error(customOpen("#f-interval-custom") ? "Enter how many days between reminders." : "Pick an interval.");
      }
      await api(`/api/reminders/${editingId}/interval`, { method: "POST", body: JSON.stringify({ days: modalVals.interval }) });
      toast("✅ Interval updated");
    } else {
      const title = $("#f-title").value.trim();
      if (!title) throw new Error("Give your reminder a name.");
      if (modalVals.interval === null) {
        throw new Error(customOpen("#f-interval-custom") ? "Enter how many days between reminders." : "Pick how often.");
      }
      if (modalVals.start === null) {
        if (customOpen("#f-start-custom")) throw new Error("Enter how many days ago, or pick a start.");
        modalVals.start = 0;
      }
      if (modalVals.time === null) {
        throw new Error(customOpen("#f-time-custom") ? "Enter a time." : "Pick a time.");
      }
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
$("#theme-btn").addEventListener("click", () => {
  applyTheme(effectiveTheme() === "dark" ? "light" : "dark");
});
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
$("#list-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".ltab");
  if (btn) setListTab(btn.dataset.ltab);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) hideModal(); });

setupAuth();

// Apply the saved theme (or the system default) before the first paint of the views
applyTheme(effectiveTheme());

(async () => {
  try {
    await api("/api/me");
    await enterApp();
  } catch {
    $("#auth-view").classList.remove("hidden");
  }
})();
