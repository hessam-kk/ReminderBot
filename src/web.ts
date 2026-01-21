// Browser API: per-user accounts, session auth, and user-scoped reminder CRUD.
// Every reminder operation is verified to belong to the authenticated user.

import type { Env } from "./types";
import * as db from "./db";
import { DEFAULT_TZ, formatNextDue, isValidTimezone, nextFromStart, nextOccurrence, TZ_PRESETS } from "./time";
import { INTERVALS, START_OPTIONS } from "./keyboards";

const { WEB_ID_BASE } = db;
const LINK_CODE_TTL = 10 * 60; // codes expire after 10 minutes
const SESSION_TTL = 30 * 86400; // 30 days
const LOCK_THRESHOLD = 5; // failed logins before locking
const LOCK_SECONDS = 15 * 60; // lock duration
const PBKDF2_ITER = 100_000;

const COOKIE = "rb_session";

// ── helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256
  );
  return b64(new Uint8Array(bits));
}

async function makePasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isFinite(iter) || iter < 1000 || iter > 1_000_000) return false;
  try {
    const salt = fromB64(parts[2]);
    const hash = await hashPassword(password, salt);
    return hash === parts[3];
  } catch {
    return false;
  }
}

function sessionCookie(token: string, secure: boolean, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  const m = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

interface AuthUser {
  id: number; // web_users.id
  username: string;
  timezone: string;
  linked: boolean;
  telegramUserId: number | null;
  telegramUsername: string | null;
}

async function currentUser(request: Request, env: Env): Promise<AuthUser | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await db.sha256Hex(token);
  const user = await db.getSessionUser(env.DB, tokenHash, Math.floor(Date.now() / 1000));
  if (!user) return null;

  // Linked accounts operate in the Telegram id space, where the bot lives;
  // the timezone is the shared one from the Telegram-side user row.
  const linked = !!user.telegram_user_id;
  let timezone = user.timezone;
  if (linked && user.telegram_user_id) {
    const tuser = await db.getUser(env.DB, user.telegram_user_id);
    timezone = tuser?.timezone ?? DEFAULT_TZ;
  }
  return {
    id: user.id,
    username: user.username,
    timezone,
    linked,
    telegramUserId: user.telegram_user_id,
    telegramUsername: user.telegram_username,
  };
}

// Unlinked web accounts use the reserved id range; linked accounts use their
// Telegram user id directly (the canonical, shared reminder space).
function reminderUserId(user: AuthUser): number {
  return user.linked && user.telegramUserId ? user.telegramUserId : WEB_ID_BASE + user.id;
}

function int(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// ── auth endpoints ───────────────────────────────────────────────────────────

async function register(request: Request, env: Env, secure: boolean): Promise<Response> {
  const body = await readJson(request);
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return err("Username must be 3–32 characters: letters, digits, underscore.", 400);
  }
  if (password.length < 8) {
    return err("Password must be at least 8 characters.", 400);
  }
  const existing = await db.getWebUserByUsername(env.DB, username);
  if (existing) return err("That username is already taken.", 409);
  const hash = await makePasswordHash(password);
  await db.createWebUser(env.DB, username, hash);
  const user = await db.getWebUserByUsername(env.DB, username);
  return issueSession(user!, request, env, secure, { created: true });
}

async function login(request: Request, env: Env, secure: boolean): Promise<Response> {
  const body = await readJson(request);
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const now = Math.floor(Date.now() / 1000);
  const user = await db.getWebUserByUsername(env.DB, username);
  if (user && user.locked_until && user.locked_until > now) {
    return err("Too many failed attempts. Try again in a few minutes.", 429);
  }
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    if (user) await db.recordLoginFailure(env.DB, user.id, now + LOCK_SECONDS);
    return err("Invalid username or password.", 401);
  }
  await db.resetLoginFailures(env.DB, user.id);
  return issueSession(user, request, env, secure, { created: false });
}

async function issueSession(
  user: db.WebUserRow,
  request: Request,
  env: Env,
  secure: boolean,
  extra: Record<string, unknown>
): Promise<Response> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await db.sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  await db.createSession(env.DB, tokenHash, user.id, now + SESSION_TTL);
  const resp = json({
    ok: true,
    username: user.username,
    timezone: user.timezone,
    linked: !!user.telegram_user_id,
    telegramUsername: user.telegram_username,
    ...extra,
  });
  resp.headers.append("Set-Cookie", sessionCookie(token, secure, SESSION_TTL));
  return resp;
}

async function logout(request: Request, env: Env, secure: boolean): Promise<Response> {
  const token = cookieToken(request);
  if (token) {
    const tokenHash = await db.sha256Hex(token);
    await db.deleteSession(env.DB, tokenHash);
  }
  const resp = json({ ok: true });
  resp.headers.append("Set-Cookie", clearCookie(secure));
  return resp;
}

async function startLink(user: AuthUser, env: Env): Promise<Response> {
  if (user.linked) return err("This account is already linked to Telegram.", 400);
  const now = Math.floor(Date.now() / 1000);
  await db.deleteExpiredLinkCodes(env.DB, now);
  const code = toHex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase(); // 8 hex chars
  const codeHash = await db.sha256Hex(code);
  await db.createLinkCode(env.DB, codeHash, user.id, now, now + LINK_CODE_TTL);
  return json({
    ok: true,
    code,
    expiresIn: LINK_CODE_TTL,
    instructions: `Open Telegram, send /link ${code} to the bot, then wait a moment.`,
  });
}

// ── authenticated endpoints ──────────────────────────────────────────────────

async function listReminders(user: AuthUser, env: Env): Promise<Response> {
  const uid = reminderUserId(user);
  const now = Math.floor(Date.now() / 1000);
  const [total, rows] = await Promise.all([
    db.countReminders(env.DB, uid),
    db.listReminders(env.DB, uid, 200, 0),
  ]);
  return json({
    total,
    now,
    reminders: rows.map(r => ({
      id: r.id,
      title: r.title,
      intervalDays: r.interval_days,
      hour: r.hour,
      minute: r.minute,
      nextDue: r.next_due,
      active: r.active === 1,
      streak: r.streak,
      bestStreak: r.best_streak,
      dueNow: r.next_due <= now,
    })),
  });
}

async function createReminder(user: AuthUser, env: Env, request: Request): Promise<Response> {
  const body = await readJson(request);
  const title = String(body.title ?? "").trim().slice(0, 200);
  const intervalDays = int(body.intervalDays);
  const hour = int(body.hour);
  const minute = int(body.minute);
  const offset = int(body.offsetDays ?? 0);
  if (!title) return err("Title is required.", 400);
  if (intervalDays === null || intervalDays < 1 || intervalDays > 3650) {
    return err("Interval must be between 1 and 3650 days.", 400);
  }
  if (hour === null || hour < 0 || hour > 23 || minute === null || minute < 0 || minute > 59) {
    return err("Time must be a valid HH:MM.", 400);
  }
  if (offset === null || offset < 0 || offset > 5000) {
    return err("Start offset must be between 0 and 5000 days.", 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const nextDue = nextFromStart(user.timezone, hour, minute, now, intervalDays, offset);
  const r = await db.createReminder(env.DB, reminderUserId(user), title, intervalDays, hour, minute, nextDue, now);
  return json({ ok: true, reminder: { id: r.id, nextDue, dueNow: nextDue <= now } }, 201);
}

async function getReminder(user: AuthUser, env: Env, id: number): Promise<Response> {
  const r = await ownReminder(user, env, id);
  if (!r) return err("Reminder not found.", 404);
  const now = Math.floor(Date.now() / 1000);
  return json({
    id: r.id,
    title: r.title,
    intervalDays: r.interval_days,
    hour: r.hour,
    minute: r.minute,
    nextDue: r.next_due,
    active: r.active === 1,
    streak: r.streak,
    bestStreak: r.best_streak,
    nextHuman: formatNextDue(user.timezone, r.next_due, now),
  });
}

async function ownReminder(user: AuthUser, env: Env, id: number): Promise<db.ReminderRow | null> {
  const r = await db.getReminder(env.DB, id);
  if (!r || r.user_id !== reminderUserId(user)) return null;
  return r;
}

async function reminderAction(user: AuthUser, env: Env, id: number, action: string, request: Request): Promise<Response> {
  const r = await ownReminder(user, env, id);
  if (!r) return err("Reminder not found.", 404);
  const now = Math.floor(Date.now() / 1000);

  switch (action) {
    case "done": {
      const updated = await db.markDone(env.DB, id, now, user.timezone);
      return json({ ok: true, streak: updated.streak, bestStreak: updated.best_streak, nextDue: updated.next_due });
    }
    case "snooze": {
      const body = await readJson(request);
      const seconds = int(body.seconds ?? 3600);
      const s = seconds === 86400 ? 86400 : 3600;
      await db.snooze(env.DB, id, now + s);
      return json({ ok: true, nextDue: now + s });
    }
    case "pause": {
      const active = await db.toggleActive(env.DB, id);
      return json({ ok: true, active: active === 1 });
    }
    case "interval": {
      const body = await readJson(request);
      const days = int(body.days);
      if (days === null || days < 1 || days > 3650) return err("Interval must be between 1 and 3650 days.", 400);
      const nextDue = nextOccurrence(user.timezone, r.hour, r.minute, now);
      await db.updateInterval(env.DB, id, days, nextDue);
      return json({ ok: true, intervalDays: days, nextDue });
    }
    default:
      return err("Not found.", 404);
  }
}

// ── stats / timezone ─────────────────────────────────────────────────────────

async function statsApi(user: AuthUser, env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const s = await db.stats(env.DB, reminderUserId(user), now);
  return json({
    totalCount: s.totalCount,
    activeCount: s.activeCount,
    totalDone: s.totalDone,
    bestStreak: s.bestStreak,
    topStreaks: s.topStreaks,
    upcoming: s.upcoming.map(u => ({ ...u, nextHuman: formatNextDue(user.timezone, u.next_due, now) })),
  });
}

// ── router ───────────────────────────────────────────────────────────────────

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  if (parts.length < 2 || parts[0] !== "api") return err("Not found.", 404);
  const method = request.method;
  const secure = url.protocol === "https:";

  if (parts.length === 2) {
    if (parts[1] === "meta") {
      return json({
        intervals: INTERVALS,
        tzPresets: TZ_PRESETS,
        startOptions: START_OPTIONS,
        defaultTz: DEFAULT_TZ,
      });
    }
    if (parts[1] === "register" && method === "POST") return register(request, env, secure);
    if (parts[1] === "login" && method === "POST") return login(request, env, secure);
    if (parts[1] === "logout" && method === "POST") return logout(request, env, secure);
  }

  const user = await currentUser(request, env);
  if (!user) return err("Not authenticated.", 401);

  if (parts.length === 2) {
    if (parts[1] === "me") {
      return json({
        username: user.username,
        timezone: user.timezone,
        linked: user.linked,
        telegramUsername: user.telegramUsername,
      });
    }
    if (parts[1] === "link" && method === "POST") return startLink(user, env);
    if (parts[1] === "stats") return statsApi(user, env);
    if (parts[1] === "reminders") {
      if (method === "GET") return listReminders(user, env);
      if (method === "POST") return createReminder(user, env, request);
    }
    if (parts[1] === "timezone") {
      if (method === "GET") return json({ timezone: user.timezone });
      if (method === "POST") {
        const body = await readJson(request);
        const tz = String(body.timezone ?? "").trim();
        if (!isValidTimezone(tz)) return err("Not a valid IANA timezone.", 400);
        if (user.linked && user.telegramUserId) {
          // Linked accounts share the Telegram-side timezone.
          await db.setTimezone(env.DB, user.telegramUserId, tz);
        } else {
          await db.setWebUserTimezone(env.DB, user.id, tz);
        }
        return json({ ok: true, timezone: tz });
      }
    }
  }

  if (parts.length >= 3 && parts[1] === "reminders") {
    const id = Number(parts[2]);
    if (!Number.isInteger(id) || id <= 0) return err("Not found.", 404);
    if (parts.length === 3) {
      if (method === "GET") return getReminder(user, env, id);
      if (method === "DELETE") {
        const r = await ownReminder(user, env, id);
        if (!r) return err("Reminder not found.", 404);
        await db.deleteReminder(env.DB, id);
        return json({ ok: true });
      }
    }
    if (parts.length === 4) {
      return reminderAction(user, env, id, parts[3], request);
    }
  }

  return err("Not found.", 404);
}
