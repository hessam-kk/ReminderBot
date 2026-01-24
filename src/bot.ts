// Telegram update dispatcher: commands, multi-step add flow, callback handling.

import type { Env, Update } from "./types";
import * as tg from "./telegram";
import * as db from "./db";
import { DEFAULT_TZ, formatNextDue, isValidTimezone, nextFromStart, nextOccurrence, pad2 } from "./time";
import {
  confirmDeleteKeyboard,
  editIntervalKeyboard,
  intervalKeyboard,
  intervalLabel,
  itemKeyboard,
  listKeyboard,
  mainMenuKeyboard,
  startKeyboard,
  startLabel,
  timeKeyboard,
  tzKeyboard,
} from "./keyboards";

const PAGE_SIZE = 6;

export async function handleUpdate(update: Update, env: Env): Promise<void> {
  try {
    if (update.message) await handleMessage(update.message, env);
    else if (update.callback_query) await handleCallback(update.callback_query, env);
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
}

// ── messages (commands + free-text input for multi-step flows) ──────────────

async function handleMessage(msg: any, env: Env): Promise<void> {
  const chatId: number | undefined = msg.chat?.id ?? msg.from?.id;
  const userId: number = msg.from?.id ?? chatId!;
  if (!chatId) return;
  const text: string = (msg.text ?? "").trim();
  await db.getOrCreateUser(env.DB, userId, chatId);

  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpText(), {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      case "/add":
        return startAdd(chatId, userId, env);
      case "/list":
      case "/myreminders":
        return showList(chatId, userId, 0, env);
      case "/stats":
        return showStats(chatId, userId, env);
      case "/timezone":
        return showTz(chatId, userId, env);
      case "/link":
        return handleLink(chatId, userId, text, msg.from?.username ?? null, env);
      case "/web":
        return handleWebLogin(chatId, userId, msg.from?.username ?? null, env);
      case "/cancel":
        await db.clearState(env.DB, userId);
        await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Cancelled. ✅", {});
        return;
      default:
        await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpText(), {
          reply_markup: mainMenuKeyboard(),
        });
        return;
    }
  }

  const st = await db.getState(env.DB, userId);
  if (!st) {
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "I didn't catch that. 🤔 Try /help to see what I can do.",
      {}
    );
    return;
  }
  const data = JSON.parse(st.data || "{}");

  if (st.state === "title") {
    const title = text.slice(0, 200);
    if (!title) return;
    await db.setState(env.DB, userId, "interval", { title });
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Got it! 📝 <b>${tg.escapeHtml(title)}</b>\n\nHow often should I remind you?`,
      { reply_markup: intervalKeyboard("add_iv") }
    );
    return;
  }

  if (st.state === "days" || st.state === "edit_days") {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 1 || n > 3650) {
      await tg.sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Please send a whole number of days between 1 and 3650 (e.g. 3).",
        {}
      );
      return;
    }
    if (st.state === "days") {
      await db.setState(env.DB, userId, "start", { ...data, days: n });
      await askStart(chatId, userId, env);
    } else {
      await applyEditInterval(chatId, userId, data.editId, n, env);
    }
    return;
  }

  if (st.state === "start") {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 0 || n > 5000) {
      await tg.sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Please send how many days ago the last time was (0 = today, e.g. 7).",
        {}
      );
      return;
    }
    await db.setState(env.DB, userId, "time", { ...data, offset: n });
    await askTime(chatId, userId, env);
    return;
  }

  if (st.state === "time") {
    const m = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) {
      await tg.sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Please send the time as HH:MM (e.g. 07:45).",
        {}
      );
      return;
    }
    await finishAdd(chatId, userId, data, +m[1], +m[2], env);
    return;
  }

  if (st.state === "tz_custom") {
    if (!isValidTimezone(text)) {
      await tg.sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "That doesn't look like a valid IANA timezone. Try e.g. <code>Asia/Tehran</code>, <code>Europe/Berlin</code>.",
        {}
      );
      return;
    }
    await db.setTimezone(env.DB, userId, text);
    await db.clearState(env.DB, userId);
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `🌍 Timezone set to <b>${tg.escapeHtml(text)}</b>. Reminders will fire at your local time.`,
      {}
    );
    return;
  }
}

// ── callbacks (inline buttons) ───────────────────────────────────────────────

async function handleCallback(cb: any, env: Env): Promise<void> {
  const data: string = cb.data ?? "";
  const chatId: number | undefined = cb.message?.chat?.id;
  const messageId: number | undefined = cb.message?.message_id;
  const userId: number = cb.from?.id;
  if (!chatId || !userId) return;

  const [action, a, b, c] = data.split("|");
  let toast: string | undefined;

  switch (action) {
    case "noop":
      break;

    case "cancel":
      await db.clearState(env.DB, userId);
      await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "Cancelled. ✅", {});
      break;

    case "add":
      await db.clearState(env.DB, userId);
      await startAdd(chatId, userId, env);
      break;

    case "add_iv": {
      const st = await db.getState(env.DB, userId);
      if (!st) break;
      const d = JSON.parse(st.data || "{}");
      if (a === "custom") {
        await db.setState(env.DB, userId, "days", d);
        await tg.sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "✏️ How many days between reminders? Send a number (e.g. 3).",
          {}
        );
      } else {
        await db.setState(env.DB, userId, "start", { ...d, days: parseInt(a, 10) });
        await askStart(chatId, userId, env);
      }
      break;
    }

    case "st": {
      const st = await db.getState(env.DB, userId);
      if (!st) break;
      const d = JSON.parse(st.data || "{}");
      if (a === "back") {
        await db.setState(env.DB, userId, "interval", d);
        await tg.sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "⏱ <b>How often should I remind you?</b>",
          { reply_markup: intervalKeyboard("add_iv") }
        );
      } else if (a === "custom") {
        await db.setState(env.DB, userId, "start", d);
        await tg.sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "✏️ How many days ago was the last time? Send a number (0 = today, e.g. 7).",
          {}
        );
      } else {
        await db.setState(env.DB, userId, "time", { ...d, offset: parseInt(a, 10) || 0 });
        await askTime(chatId, userId, env);
      }
      break;
    }

    case "add_time": {
      const st = await db.getState(env.DB, userId);
      if (!st) break;
      const d = JSON.parse(st.data || "{}");
      if (a === "custom") {
        await db.setState(env.DB, userId, "time", d);
        await tg.sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "✏️ Send the time as HH:MM (e.g. 07:45).",
          {}
        );
      } else {
        const [h, m] = a.split(":").map(Number);
        await finishAdd(chatId, userId, d, h, m, env);
      }
      break;
    }

    case "list":
      await showList(chatId, userId, parseInt(a ?? "0", 10) || 0, env, messageId);
      break;

    case "item":
      await showItem(chatId, userId, parseInt(a, 10), parseInt(b ?? "0", 10) || 0, env, messageId);
      break;

    case "done":
      toast = await markDone(chatId, userId, parseInt(a, 10), env, messageId);
      break;

    case "snooze":
      toast = await snooze(chatId, userId, parseInt(a, 10), parseInt(b ?? "86400", 10), env, messageId);
      break;

    case "pause":
      toast = await togglePause(chatId, userId, parseInt(a, 10), parseInt(b ?? "0", 10) || 0, env, messageId);
      break;

    case "del":
      await confirmDelete(chatId, userId, parseInt(a, 10), parseInt(b ?? "0", 10) || 0, env, messageId);
      break;

    case "delc": {
      const id = parseInt(b, 10);
      const page = parseInt(c ?? "0", 10) || 0;
      if (a === "y") {
        const r = await db.getReminder(env.DB, id);
        await db.deleteReminder(env.DB, id);
        await editOrSend(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          messageId,
          `🗑 Deleted <b>${tg.escapeHtml(r?.title ?? "reminder")}</b>.`,
          {}
        );
      } else {
        await showItem(chatId, userId, id, page, env, messageId);
      }
      break;
    }

    case "edit":
      await showEditInterval(chatId, userId, parseInt(a, 10), parseInt(b ?? "0", 10) || 0, env, messageId);
      break;

    case "edit_iv": {
      const id = parseInt(a, 10);
      const page = parseInt(c ?? "0", 10) || 0;
      if (b === "custom") {
        await db.setState(env.DB, userId, "edit_days", { editId: id });
        await tg.sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "✏️ How many days between reminders? Send a number (e.g. 3).",
          {}
        );
      } else {
        await applyEditInterval(chatId, userId, id, parseInt(b, 10), env, messageId);
      }
      break;
    }

    case "stats":
      await showStats(chatId, userId, env, messageId);
      break;

    case "help":
      await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, helpText(), {
        reply_markup: mainMenuKeyboard(),
      });
      break;

    case "web":
      await handleWebLogin(chatId, userId, cb.from?.username ?? null, env);
      break;

    case "tz":
      await showTz(chatId, userId, env, messageId);
      break;

    case "tzset": {
      const tz = a;
      if (!isValidTimezone(tz)) break;
      await db.setTimezone(env.DB, userId, tz);
      toast = `🌍 ${tz}`;
      await editOrSend(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        messageId,
        `🌍 Timezone set to <b>${tg.escapeHtml(tz)}</b>.\n\nReminders now fire at your local time.`,
        {}
      );
      break;
    }

    case "tz_custom":
      await db.setState(env.DB, userId, "tz_custom", {});
      await tg.sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "✏️ Send your IANA timezone name (e.g. <code>Asia/Tehran</code>, <code>Europe/Berlin</code>).",
        {}
      );
      break;
  }

  await tg.answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cb.id, toast);
}

// ── web linking ──────────────────────────────────────────────────────────────

async function handleLink(
  chatId: number,
  userId: number,
  text: string,
  telegramUsername: string | null,
  env: Env
): Promise<void> {
  const code = text.replace(/^\/link\s*/i, "").trim().toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(code)) {
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "To connect your web account, get a code on the web app (🔗 Link Telegram) and send:\n<code>/link CODE</code>",
      {}
    );
    return;
  }

  const codeHash = await db.sha256Hex(code);
  const lc = await db.getLinkCode(env.DB, codeHash);
  const now = Math.floor(Date.now() / 1000);
  if (!lc || lc.expires_at <= now) {
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "That code is invalid or expired. Generate a fresh one on the web app and try again.",
      {}
    );
    return;
  }

  if (!lc.web_user_id) {
    await db.deleteLinkCode(env.DB, codeHash);
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "That code wasn't issued for linking. Get a fresh one on the web app.",
      {}
    );
    return;
  }

  const webUser = await db.getWebUserById(env.DB, lc.web_user_id);
  if (!webUser) {
    await db.deleteLinkCode(env.DB, codeHash);
    await tg.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Something went wrong. Please try again.", {});
    return;
  }
  if (webUser.telegram_user_id) {
    await db.deleteLinkCode(env.DB, codeHash);
    await tg.sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "That web account is already connected to a Telegram account.",
      {}
    );
    return;
  }

  // The Telegram user becomes the canonical account: create/refresh its row,
  // adopt the web user's timezone, then move the web reminders over.
  await db.getOrCreateUser(env.DB, userId, chatId);
  await db.setTimezone(env.DB, userId, webUser.timezone);
  const moved = await db.migrateWebReminders(env.DB, webUser.id, userId);
  await db.linkWebUserToTelegram(env.DB, webUser.id, userId, telegramUsername);
  await db.deleteLinkCode(env.DB, codeHash);

  await tg.sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `✅ <b>Connected!</b> Your web account and this bot now share one reminder list.` +
      (moved > 0 ? `\n\n📦 Moved ${moved} reminder(s) from the web into this list.` : "") +
      `\n\nEverything you add here or on the web shows up in both.`,
    {}
  );
}

// ── bot-first web login ──────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function handleWebLogin(
  chatId: number,
  userId: number,
  telegramUsername: string | null,
  env: Env
): Promise<void> {
  const code = toHex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase(); // 8 hex chars
  const codeHash = await db.sha256Hex(code);
  const now = Math.floor(Date.now() / 1000);
  await db.deleteExpiredLinkCodes(env.DB, now);
  await db.createLinkCode(env.DB, codeHash, null, userId, telegramUsername, now, now + 10 * 60);
  await tg.sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `🌐 <b>Your web login code</b>\n\n` +
      `Open the web app and choose <b>“Log in with Telegram code”</b>, then enter:\n\n` +
      `<code>${code}</code>\n\n` +
      `It expires in 10 minutes and works once. If you don't have a web account yet, one will be created and connected to this bot automatically.`,
    {}
  );
}

// ── flows ────────────────────────────────────────────────────────────────────

async function startAdd(chatId: number, userId: number, env: Env): Promise<void> {
  await db.setState(env.DB, userId, "title", {});
  await tg.sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "📝 <b>What should I remind you about?</b>\n\nSend the item name, e.g. <i>Vitamin D pills</i>.",
    {}
  );
}

async function askStart(chatId: number, userId: number, env: Env): Promise<void> {
  await tg.sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "📅 <b>When was the last time you did this?</b>\n\n" +
      "This sets when your first reminder arrives. For example: last took it a week ago + \"every 2 weeks\" → next reminder in 1 week.\n\n" +
      "Pick <b>Today</b> to start from now:",
    { reply_markup: startKeyboard() }
  );
}

async function askTime(chatId: number, userId: number, env: Env): Promise<void> {
  const user = await db.getUser(env.DB, userId);
  await tg.sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `🕐 <b>What time should it fire?</b>\n(Your timezone: ${tg.escapeHtml(user?.timezone ?? DEFAULT_TZ)})`,
    { reply_markup: timeKeyboard() }
  );
}

async function finishAdd(
  chatId: number,
  userId: number,
  data: any,
  hour: number,
  minute: number,
  env: Env
): Promise<void> {
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const now = Math.floor(Date.now() / 1000);
  const offset = Math.max(0, Number(data.offset ?? 0) || 0);
  const nextDue = nextFromStart(user.timezone, hour, minute, now, data.days, offset);
  const r = await db.createReminder(env.DB, userId, data.title, data.days, hour, minute, nextDue, now);
  await db.clearState(env.DB, userId);
  const startNote = offset > 0 ? ` (from ${startLabel(offset)})` : "";
  await tg.sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `✅ <b>Reminder added!</b>\n\n${tg.escapeHtml(r.title)}\n⏱ ${intervalLabel(r.interval_days)} at ${pad2(hour)}:${pad2(minute)}\n🔔 First reminder: ${formatNextDue(user.timezone, nextDue, now)}${startNote}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 My reminders", callback_data: "list|0" },
            { text: "➕ Add another", callback_data: "add" },
          ],
        ],
      },
    }
  );
}

async function showList(
  chatId: number,
  userId: number,
  page: number,
  env: Env,
  messageId?: number
): Promise<void> {
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const total = await db.countReminders(env.DB, userId);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const items = await db.listReminders(env.DB, userId, PAGE_SIZE, p * PAGE_SIZE);
  const now = Math.floor(Date.now() / 1000);

  let text: string;
  if (total === 0) {
    text = "📋 <b>You have no reminders yet.</b>\n\nTap ➕ Add to create your first one!";
  } else {
    const lines = items.map((r, i) => {
      const when = r.next_due <= now ? "🔴 due now" : `next ${formatNextDue(user.timezone, r.next_due, now)}`;
      return `${p * PAGE_SIZE + i + 1}. ${r.active ? "" : "⏸ "}${tg.escapeHtml(r.title)} — ${intervalLabel(r.interval_days)} · ${when}`;
    });
    text = `📋 <b>Your reminders</b> (${total})\n\n${lines.join("\n")}`;
  }
  await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, {
    reply_markup: listKeyboard(items, p, totalPages),
  });
}

async function showItem(
  chatId: number,
  userId: number,
  id: number,
  page: number,
  env: Env,
  messageId?: number
): Promise<void> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) {
    await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, "Reminder not found. 🤷", {});
    return;
  }
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const now = Math.floor(Date.now() / 1000);
  const when = r.next_due <= now ? "🔴 due now" : `Next: ${formatNextDue(user.timezone, r.next_due, now)}`;
  const text =
    `<b>${tg.escapeHtml(r.title)}</b>\n` +
    `⏱ ${intervalLabel(r.interval_days)} at ${pad2(r.hour)}:${pad2(r.minute)}\n` +
    `${when}\n` +
    `🔥 Streak: ${r.streak} (best ${r.best_streak})\n` +
    (r.active ? "" : "⏸ Paused");
  await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, {
    reply_markup: itemKeyboard(r, page),
  });
}

async function showEditInterval(
  chatId: number,
  userId: number,
  id: number,
  page: number,
  env: Env,
  messageId?: number
): Promise<void> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) return;
  await editOrSend(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    messageId,
    `✏️ <b>${tg.escapeHtml(r.title)}</b> — choose a new interval:`,
    { reply_markup: editIntervalKeyboard(id, page) }
  );
}

async function applyEditInterval(
  chatId: number,
  userId: number,
  id: number,
  days: number,
  env: Env,
  messageId?: number
): Promise<void> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) return;
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const now = Math.floor(Date.now() / 1000);
  const nextDue = nextOccurrence(user.timezone, r.hour, r.minute, now);
  await db.updateInterval(env.DB, id, days, nextDue);
  await db.clearState(env.DB, userId);
  const text =
    `✅ Interval updated!\n\n${tg.escapeHtml(r.title)} — ${intervalLabel(days)} at ${pad2(r.hour)}:${pad2(r.minute)}\n` +
    `🔔 Next: ${formatNextDue(user.timezone, nextDue, now)}`;
  await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, {});
}

async function markDone(
  chatId: number,
  userId: number,
  id: number,
  env: Env,
  messageId?: number
): Promise<string | undefined> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) return;
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const now = Math.floor(Date.now() / 1000);
  const updated = await db.markDone(env.DB, id, now, user.timezone);
  const text =
    `🎉 <b>${tg.escapeHtml(r.title)}</b> done!\n` +
    `🔥 Streak: ${updated.streak}${updated.streak >= updated.best_streak ? " — new best!" : ` (best ${updated.best_streak})`}\n` +
    `🔔 Next: ${formatNextDue(user.timezone, updated.next_due, now)}`;
  await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, {});
  return `🔥 Done! Streak ${updated.streak}`;
}

async function snooze(
  chatId: number,
  userId: number,
  id: number,
  seconds: number,
  env: Env,
  messageId?: number
): Promise<string | undefined> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) return;
  const now = Math.floor(Date.now() / 1000);
  await db.snooze(env.DB, id, now + seconds);
  const label = seconds >= 86400 ? "1 day" : "1 hour";
  await editOrSend(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    messageId,
    `⏰ <b>${tg.escapeHtml(r.title)}</b> snoozed for ${label}. I'll nudge you again.`,
    {}
  );
  return `⏰ +${label}`;
}

async function togglePause(
  chatId: number,
  userId: number,
  id: number,
  page: number,
  env: Env,
  messageId?: number
): Promise<string | undefined> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) return;
  const active = await db.toggleActive(env.DB, id);
  await showItem(chatId, userId, id, page, env, messageId);
  return active ? "▶️ Resumed" : "⏸ Paused";
}

async function confirmDelete(
  chatId: number,
  userId: number,
  id: number,
  page: number,
  env: Env,
  messageId?: number
): Promise<void> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== userId) return;
  await editOrSend(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    messageId,
    `🗑 Delete <b>${tg.escapeHtml(r.title)}</b>? This cannot be undone.`,
    { reply_markup: confirmDeleteKeyboard(id, page) }
  );
}

async function showStats(chatId: number, userId: number, env: Env, messageId?: number): Promise<void> {
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const s = await db.stats(env.DB, userId, Math.floor(Date.now() / 1000));
  const now = Math.floor(Date.now() / 1000);
  const top = s.topStreaks.length
    ? s.topStreaks.map(r => `• ${tg.escapeHtml(r.title)} — 🔥 ${r.streak}`).join("\n")
    : "• Nothing yet — complete your first reminder!";
  const up = s.upcoming.length
    ? s.upcoming.map(r => `• ${tg.escapeHtml(r.title)} — ${formatNextDue(user.timezone, r.next_due, now)}`).join("\n")
    : "• No upcoming reminders.";
  const text =
    `📊 <b>Your stats</b>\n\n` +
    `✅ Active reminders: ${s.activeCount} / ${s.totalCount}\n` +
    `🎯 Total completions: ${s.totalDone}\n` +
    `🏆 Best streak ever: ${s.bestStreak}\n\n` +
    `🔥 <b>Top streaks</b>\n${top}\n\n` +
    `🔜 <b>Upcoming</b>\n${up}`;
  await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, {});
}

async function showTz(chatId: number, userId: number, env: Env, messageId?: number): Promise<void> {
  const user = await db.getOrCreateUser(env.DB, userId, chatId);
  const text = `🌍 <b>Your timezone:</b> <code>${tg.escapeHtml(user.timezone)}</code>\n\nPick a new one:`;
  await editOrSend(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, { reply_markup: tzKeyboard() });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function editOrSend(
  token: string,
  chatId: number,
  messageId: number | undefined,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (messageId) {
    try {
      await tg.editMessageText(token, chatId, messageId, text, extra);
      return;
    } catch (e) {
      if (e instanceof Error && /not modified/i.test(e.message)) return;
      // message may have been deleted — fall back to sending a new one
    }
  }
  await tg.sendMessage(token, chatId, text, extra);
}

function helpText(): string {
  return (
    `🤖 <b>Recurring Reminder Bot</b>\n\n` +
    `Never forget the little things:\n` +
    `💊 Vitamin D — every 2 weeks\n` +
    `💧 Water — every day\n` +
    `🏋️ Workout — every 3 days (custom)\n\n` +
    `<b>Commands</b>\n` +
    `/start — main menu\n` +
    `/add — add a reminder\n` +
    `/list — manage reminders (done, pause, edit, delete)\n` +
    `/stats — streaks & stats\n` +
    `/timezone — change timezone (default Tehran 🇮🇷)\n` +
    `/link — connect your web account (code from the web app)\n` +
    `/web — get a code to log into the web app\n` +
    `/cancel — cancel the current action\n\n` +
    `When a reminder is due you'll get buttons: ✅ Done, ⏰ +1h, ⏰ +1d, 🗑 Delete.\n\n` +
    `🌐 <b>Web app</b>: reminder-bot.hessam2.workers.dev — manage reminders in your browser, log in with a code from /web.`
  );
}