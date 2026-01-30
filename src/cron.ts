// Cron sweep: deliver due reminders, then schedule the next occurrence.
// Invoked by the worker's scheduled handler every 5 minutes.

import type { Env } from "./types";
import { advanceNextDue, deactivate, getDueReminders, getUser } from "./db";
import { escapeHtml, sendMessage } from "./telegram";
import { occurrenceAfterDays } from "./time";
import { dueKeyboard, intervalLabel } from "./keyboards";

export async function runCron(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = await getDueReminders(env.DB, now);
  if (due.length === 0) return;

  for (const r of due) {
    const user = await getUser(env.DB, r.user_id);
    if (!user) continue;

    const text =
      `🔔 <b>${escapeHtml(r.title)}</b>\n` +
      `⏱ ${intervalLabel(r.interval_days)}\n\n` +
      `Tap ✅ when done, or ⏰ to snooze.`;

    try {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, text, {
        reply_markup: dueKeyboard(r),
      });
      // Schedule the next cycle immediately so we never spam the same
      // reminder; Done/Snooze may still reschedule from here. The cycle is
      // measured in local calendar days, not 24h blocks, so fractional
      // offsets and DST can't shift it onto the wrong day.
      await advanceNextDue(
        env.DB,
        r.id,
        occurrenceAfterDays(user.timezone, r.hour, r.minute, now, r.interval_days)
      );
    } catch (e) {
      console.error(`cron: failed to deliver reminder ${r.id}:`, e);
      // Bot blocked/chat closed → stop retrying forever
      if (e instanceof Error && /forbidden|blocked by the user|bot was kicked/i.test(e.message)) {
        await deactivate(env.DB, r.id);
      }
    }
  }
}