// Timezone-aware scheduling helpers. All timestamps are epoch seconds (UTC);
// wall-clock formatting/alignment is done per-user via Intl with IANA timezones.

export const DEFAULT_TZ = "Asia/Tehran";

// `label` (emoji flags) is used by the Telegram keyboards, where flags render
// natively. The web UI uses `code` + `name` instead, because flag emoji are
// regional indicators that render inconsistently across browsers/OSes.
export const TZ_PRESETS = [
  { id: "Asia/Tehran", code: "IR", name: "Tehran (UTC+3:30)", label: "🇮🇷 Tehran (UTC+3:30)" },
  { id: "Etc/UTC", code: "UTC", name: "UTC", label: "🌍 UTC" },
  { id: "Europe/London", code: "GB", name: "London", label: "🇬🇧 London" },
  { id: "Europe/Berlin", code: "DE", name: "Berlin", label: "🇩🇪 Berlin" },
  { id: "Asia/Dubai", code: "AE", name: "Dubai", label: "🇦🇪 Dubai" },
  { id: "Asia/Kolkata", code: "IN", name: "Delhi", label: "🇮🇳 Delhi" },
  { id: "America/New_York", code: "US", name: "New York", label: "🇺🇸 New York" },
];

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const weekdayCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localTimeAt(tz: string, epochSec: number): LocalTime {
  const parts = formatter(tz).formatToParts(new Date(epochSec * 1000));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

export function localMidnightEpoch(tz: string, epochSec: number): number {
  const lt = localTimeAt(tz, epochSec);
  return epochSec - (lt.hour * 3600 + lt.minute * 60 + lt.second);
}

/**
 * First epoch strictly after `afterEpoch` whose wall-clock time in `tz`
 * is `hour:minute`. Handles DST gaps (skips nonexistent times) and
 * optionally picks the earlier of ambiguous fall-back times.
 */
export function nextOccurrence(tz: string, hour: number, minute: number, afterEpoch: number): number {
  let day = localMidnightEpoch(tz, afterEpoch);
  for (let i = 0; i < 370; i++) {
    const candidate = day + hour * 3600 + minute * 60;
    const lt = localTimeAt(tz, candidate);
    if (lt.hour === hour && lt.minute === minute) {
      if (candidate > afterEpoch) return candidate;
    } else {
      // DST gap/shift: correct by the wall-clock difference if that yields
      // a matching real time.
      const diffMin = hour * 60 + minute - (lt.hour * 60 + lt.minute);
      const fixed = candidate + diffMin * 60;
      if (fixed > afterEpoch) {
        const lt2 = localTimeAt(tz, fixed);
        if (lt2.hour === hour && lt2.minute === minute) return fixed;
      }
    }
    day += 86400;
  }
  return day + hour * 3600 + minute * 60; // unreachable safety net
}

/**
 * The occurrence of `hour:minute` on the local calendar day that is `days`
 * after the local date of `fromEpoch`.
 *
 * Use this to advance a reminder by its interval. Adding `days * 86400` to the
 * instant and then snapping forward is wrong: completing a daily 23:00 reminder
 * at 23:00:05 would land on 23:00 two days later instead of tomorrow.
 */
export function occurrenceAfterDays(
  tz: string,
  hour: number,
  minute: number,
  fromEpoch: number,
  days: number
): number {
  const from = localTimeAt(tz, fromEpoch);
  const target = new Date(Date.UTC(from.year, from.month - 1, from.day + Math.max(1, Math.floor(days))));
  const y = target.getUTCFullYear();
  const mo = target.getUTCMonth();
  const d = target.getUTCDate();
  const nominal = Date.UTC(y, mo, d, hour, minute, 0) / 1000;

  // Resolve that wall-clock time in `tz` by iterating the UTC offset, so DST
  // changes between now and the target date are taken into account.
  let epoch = nominal;
  for (let i = 0; i < 3; i++) {
    const seen = localTimeAt(tz, epoch);
    const offset =
      Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) / 1000 - epoch;
    const fixed = nominal - offset;
    if (fixed === epoch) break;
    epoch = fixed;
  }

  const check = localTimeAt(tz, epoch);
  if (check.hour === hour && check.minute === minute) return epoch;
  return nextOccurrence(tz, hour, minute, epoch - 1); // nonexistent local time (DST gap)
}

/**
 * First due after `now` aligned to a repeating cycle that already has a phase.
 *
 * `offsetDays` = how many days ago the LAST cycle happened (0 = today). The
 * cycle repeats every `intervalDays` starting from that reference, so the
 * first future fire is the earliest occurrence of hour:minute after `now` that
 * lands one full interval after the reference. E.g. last cycle 7 days ago with
 * a 14-day interval yields a fire 7 days from now.
 */
export function nextFromStart(
  tz: string,
  hour: number,
  minute: number,
  now: number,
  intervalDays: number,
  offsetDays: number
): number {
  const nowMid = localMidnightEpoch(tz, now);
  const off = Math.max(0, Math.floor(offsetDays));
  const k0 = Math.max(0, Math.ceil(off / Math.max(1, intervalDays)));
  for (let k = k0; k < k0 + 1000; k++) {
    const dayMid = nowMid + (k * intervalDays - off) * 86400;
    const cand = nextOccurrence(tz, hour, minute, dayMid - 1);
    if (cand > now) return cand;
  }
  return nextOccurrence(tz, hour, minute, now); // unreachable safety net
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatNextDue(tz: string, epochSec: number, nowSec: number): string {
  const lt = localTimeAt(tz, epochSec);
  const hm = `${pad2(lt.hour)}:${pad2(lt.minute)}`;
  const dayDiff = Math.round((localMidnightEpoch(tz, epochSec) - localMidnightEpoch(tz, nowSec)) / 86400);
  if (dayDiff <= 0) return `today ${hm}`;
  if (dayDiff === 1) return `tomorrow ${hm}`;
  let wf = weekdayCache.get(tz);
  if (!wf) {
    wf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    weekdayCache.set(tz, wf);
  }
  return `${wf.format(new Date(epochSec * 1000))} ${hm}`;
}