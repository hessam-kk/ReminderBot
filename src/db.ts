// D1 data access layer.

import type { D1Database } from "@cloudflare/workers-types";
import { DEFAULT_TZ, nextOccurrence } from "./time";

export interface UserRow {
  id: number;
  chat_id: number;
  timezone: string;
  created_at: number;
}

export interface ReminderRow {
  id: number;
  user_id: number;
  title: string;
  interval_days: number;
  hour: number;
  minute: number;
  next_due: number;
  active: number;
  streak: number;
  best_streak: number;
  last_done_at: number | null;
  created_at: number;
}

export interface StateRow {
  user_id: number;
  state: string;
  data: string;
  updated_at: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── users ────────────────────────────────────────────────────────────────────

export async function getOrCreateUser(db: D1Database, userId: number, chatId?: number): Promise<UserRow> {
  const existing = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (existing) {
    if (chatId && chatId !== existing.chat_id) {
      await db.prepare("UPDATE users SET chat_id = ? WHERE id = ?").bind(chatId, userId).run();
      existing.chat_id = chatId;
    }
    return existing;
  }
  const created = nowSec();
  const chat = chatId ?? userId;
  await db
    .prepare("INSERT INTO users (id, chat_id, timezone, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, chat, DEFAULT_TZ, created)
    .run();
  return { id: userId, chat_id: chat, timezone: DEFAULT_TZ, created_at: created };
}

export async function getUser(db: D1Database, userId: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function setTimezone(db: D1Database, userId: number, tz: string): Promise<void> {
  await db.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(tz, userId).run();
}

// ── conversation states ──────────────────────────────────────────────────────

export async function getState(db: D1Database, userId: number): Promise<StateRow | null> {
  return db.prepare("SELECT * FROM states WHERE user_id = ?").bind(userId).first<StateRow>();
}

export async function setState(
  db: D1Database,
  userId: number,
  state: string,
  data: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO states (user_id, state, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`
    )
    .bind(userId, state, JSON.stringify(data), nowSec())
    .run();
}

export async function clearState(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM states WHERE user_id = ?").bind(userId).run();
}

// ── reminders ────────────────────────────────────────────────────────────────

export async function createReminder(
  db: D1Database,
  userId: number,
  title: string,
  intervalDays: number,
  hour: number,
  minute: number,
  nextDue: number,
  created: number
): Promise<ReminderRow> {
  const res = await db
    .prepare(
      "INSERT INTO reminders (user_id, title, interval_days, hour, minute, next_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(userId, title, intervalDays, hour, minute, nextDue, created)
    .run();
  return {
    id: Number(res.meta.last_row_id),
    user_id: userId,
    title,
    interval_days: intervalDays,
    hour,
    minute,
    next_due: nextDue,
    active: 1,
    streak: 0,
    best_streak: 0,
    last_done_at: null,
    created_at: created,
  };
}

export async function listReminders(
  db: D1Database,
  userId: number,
  limit: number,
  offset: number
): Promise<ReminderRow[]> {
  // limit/offset are internal constants — inline to avoid D1 binding quirks
  const { results } = await db
    .prepare(`SELECT * FROM reminders WHERE user_id = ? ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`)
    .bind(userId)
    .all<ReminderRow>();
  return results;
}

export async function countReminders(db: D1Database, userId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM reminders WHERE user_id = ?")
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getReminder(db: D1Database, id: number): Promise<ReminderRow | null> {
  return db.prepare("SELECT * FROM reminders WHERE id = ?").bind(id).first<ReminderRow>();
}

export async function deleteReminder(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM done_history WHERE reminder_id = ?").bind(id).run();
  await db.prepare("DELETE FROM reminders WHERE id = ?").bind(id).run();
}

export async function markDone(db: D1Database, id: number, now: number, tz: string): Promise<ReminderRow> {
  const r = await getReminder(db, id);
  if (!r) throw new Error("reminder not found");
  const nextDue = nextOccurrence(tz, r.hour, r.minute, now + r.interval_days * 86400);
  await db
    .prepare(
      "UPDATE reminders SET streak = streak + 1, best_streak = MAX(best_streak, streak + 1), last_done_at = ?, next_due = ? WHERE id = ?"
    )
    .bind(now, nextDue, id)
    .run();
  await db.prepare("INSERT INTO done_history (reminder_id, done_at) VALUES (?, ?)").bind(id, now).run();
  return {
    ...r,
    streak: r.streak + 1,
    best_streak: Math.max(r.best_streak, r.streak + 1),
    last_done_at: now,
    next_due: nextDue,
  };
}

export async function snooze(db: D1Database, id: number, until: number): Promise<void> {
  await db.prepare("UPDATE reminders SET next_due = ? WHERE id = ?").bind(until, id).run();
}

export async function advanceNextDue(db: D1Database, id: number, nextDue: number): Promise<void> {
  await db.prepare("UPDATE reminders SET next_due = ? WHERE id = ?").bind(nextDue, id).run();
}

export async function toggleActive(db: D1Database, id: number): Promise<number> {
  const r = await getReminder(db, id);
  if (!r) return 0;
  const next = r.active ? 0 : 1;
  await db.prepare("UPDATE reminders SET active = ? WHERE id = ?").bind(next, id).run();
  return next;
}

export async function updateInterval(db: D1Database, id: number, days: number, nextDue: number): Promise<void> {
  await db
    .prepare("UPDATE reminders SET interval_days = ?, next_due = ? WHERE id = ?")
    .bind(days, nextDue, id)
    .run();
}

export async function deactivate(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE reminders SET active = 0 WHERE id = ?").bind(id).run();
}

export async function getDueReminders(db: D1Database, now: number): Promise<ReminderRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM reminders WHERE active = 1 AND next_due <= ?")
    .bind(now)
    .all<ReminderRow>();
  return results;
}

// ── stats ────────────────────────────────────────────────────────────────────

export interface Stats {
  totalCount: number;
  activeCount: number;
  totalDone: number;
  bestStreak: number;
  topStreaks: { title: string; streak: number }[];
  upcoming: { id: number; title: string; next_due: number }[];
}

export async function stats(db: D1Database, userId: number, now: number): Promise<Stats> {
  const totalRow = await db
    .prepare("SELECT COUNT(*) AS c FROM reminders WHERE user_id = ?")
    .bind(userId)
    .first<{ c: number }>();
  const activeRow = await db
    .prepare("SELECT COUNT(*) AS c FROM reminders WHERE user_id = ? AND active = 1")
    .bind(userId)
    .first<{ c: number }>();
  const doneRow = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM done_history dh JOIN reminders r ON r.id = dh.reminder_id WHERE r.user_id = ?"
    )
    .bind(userId)
    .first<{ c: number }>();
  const bestRow = await db
    .prepare("SELECT COALESCE(MAX(best_streak), 0) AS m FROM reminders WHERE user_id = ?")
    .bind(userId)
    .first<{ m: number }>();
  const top = await db
    .prepare("SELECT title, streak FROM reminders WHERE user_id = ? AND active = 1 ORDER BY streak DESC LIMIT 3")
    .bind(userId)
    .all<{ title: string; streak: number }>();
  const upcoming = await db
    .prepare(
      "SELECT id, title, next_due FROM reminders WHERE user_id = ? AND active = 1 AND next_due > ? ORDER BY next_due ASC LIMIT 3"
    )
    .bind(userId, now)
    .all<{ id: number; title: string; next_due: number }>();
  return {
    totalCount: totalRow?.c ?? 0,
    activeCount: activeRow?.c ?? 0,
    totalDone: doneRow?.c ?? 0,
    bestStreak: bestRow?.m ?? 0,
    topStreaks: top.results,
    upcoming: upcoming.results,
  };
}