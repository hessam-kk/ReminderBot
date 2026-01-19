// All inline keyboards. Callback data is pipe-separated: action|arg|arg

import { TZ_PRESETS } from "./time";

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export const INTERVALS = [
  { days: 1, label: "Every day" },
  { days: 7, label: "Every week" },
  { days: 14, label: "Every 2 weeks" },
  { days: 30, label: "Every month" },
  { days: 90, label: "Every 3 months" },
  { days: 180, label: "Every 6 months" },
  { days: 365, label: "Every year" },
];

export function intervalLabel(days: number): string {
  const preset = INTERVALS.find(i => i.days === days);
  return preset ? preset.label.toLowerCase() : `every ${days} days`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function intervalRows(prefix: string, back?: InlineKeyboardButton): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    INTERVALS.slice(0, 3).map(i => ({ text: i.label, callback_data: `${prefix}|${i.days}` })),
    INTERVALS.slice(3, 6).map(i => ({ text: i.label, callback_data: `${prefix}|${i.days}` })),
    [
      { text: INTERVALS[6].label, callback_data: `${prefix}|${INTERVALS[6].days}` },
      { text: "✏️ Custom…", callback_data: `${prefix}|custom` },
    ],
  ];
  if (back) rows.push([back]);
  return rows;
}

export function intervalKeyboard(prefix: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [...intervalRows(prefix), [{ text: "❌ Cancel", callback_data: "cancel" }]],
  };
}

export function editIntervalKeyboard(id: number, page: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...intervalRows(`edit_iv|${id}`, { text: "⬅️ Back", callback_data: `item|${id}|${page}` }),
    ],
  };
}

export const START_OPTIONS = [
  { offset: 0, label: "📍 Today" },
  { offset: 1, label: "1 day ago" },
  { offset: 3, label: "3 days ago" },
  { offset: 7, label: "1 week ago" },
  { offset: 14, label: "2 weeks ago" },
  { offset: 30, label: "1 month ago" },
];

export function startLabel(offset: number): string {
  if (offset <= 0) return "today";
  if (offset === 1) return "1 day ago";
  if (offset === 7) return "1 week ago";
  if (offset === 14) return "2 weeks ago";
  if (offset === 30) return "1 month ago";
  return `${offset} days ago`;
}

export function startKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: START_OPTIONS[0].label, callback_data: `st|${START_OPTIONS[0].offset}` }],
      [
        { text: START_OPTIONS[1].label, callback_data: `st|${START_OPTIONS[1].offset}` },
        { text: START_OPTIONS[2].label, callback_data: `st|${START_OPTIONS[2].offset}` },
      ],
      [
        { text: START_OPTIONS[3].label, callback_data: `st|${START_OPTIONS[3].offset}` },
        { text: START_OPTIONS[4].label, callback_data: `st|${START_OPTIONS[4].offset}` },
      ],
      [
        { text: START_OPTIONS[5].label, callback_data: `st|${START_OPTIONS[5].offset}` },
        { text: "✏️ Custom…", callback_data: "st|custom" },
      ],
      [
        { text: "⬅️ Back", callback_data: "st|back" },
        { text: "❌ Cancel", callback_data: "cancel" },
      ],
    ],
  };
}

export function timeKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ["09:00", "12:00", "18:00"].map(h => ({ text: `🕘 ${h}`, callback_data: `add_time|${h}` })),
      ["06:00", "21:00", "23:00"].map(h => ({ text: `🕘 ${h}`, callback_data: `add_time|${h}` })),
      [{ text: "✏️ Custom time…", callback_data: "add_time|custom" }],
      [{ text: "❌ Cancel", callback_data: "cancel" }],
    ],
  };
}

// Buttons attached to the cron notification message
export function dueKeyboard(r: { id: number }): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Done", callback_data: `done|${r.id}` },
        { text: "⏰ +1h", callback_data: `snooze|${r.id}|3600` },
        { text: "⏰ +1d", callback_data: `snooze|${r.id}|86400` },
        { text: "🗑 Delete", callback_data: `del|${r.id}|0` },
      ],
    ],
  };
}

export function listKeyboard(
  items: { id: number; title: string; active: number }[],
  page: number,
  totalPages: number
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = items.map(r => [
    {
      text: `${r.active ? "" : "⏸ "}${truncate(r.title, 40)}`,
      callback_data: `item|${r.id}|${page}`,
    },
  ]);
  rows.push([
    { text: "➕ Add", callback_data: "add" },
    { text: "🔄 Refresh", callback_data: `list|${page}` },
  ]);
  if (totalPages > 1) {
    const nav: InlineKeyboardButton[] = [];
    if (page > 0) nav.push({ text: "◀️", callback_data: `list|${page - 1}` });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
    if (page < totalPages - 1) nav.push({ text: "▶️", callback_data: `list|${page + 1}` });
    rows.push(nav);
  }
  return { inline_keyboard: rows };
}

export function itemKeyboard(r: { id: number; active: number }, page: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Done", callback_data: `done|${r.id}` },
        { text: "⏰ +1d", callback_data: `snooze|${r.id}|86400` },
      ],
      [
        { text: r.active ? "⏸ Pause" : "▶️ Resume", callback_data: `pause|${r.id}|${page}` },
        { text: "✏️ Interval", callback_data: `edit|${r.id}|${page}` },
      ],
      [{ text: "🗑 Delete", callback_data: `del|${r.id}|${page}` }],
      [{ text: "⬅️ Back", callback_data: `list|${page}` }],
    ],
  };
}

export function confirmDeleteKeyboard(id: number, page: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🗑 Yes, delete", callback_data: `delc|y|${id}|${page}` },
        { text: "↩️ No, keep", callback_data: `delc|n|${id}|${page}` },
      ],
    ],
  };
}

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add reminder", callback_data: "add" }],
      [{ text: "📋 My reminders", callback_data: "list|0" }],
      [{ text: "📊 Stats", callback_data: "stats" }],
      [{ text: "🌍 Timezone", callback_data: "tz" }],
    ],
  };
}

export function tzKeyboard(): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = TZ_PRESETS.map(p => [
    { text: p.label, callback_data: `tzset|${p.id}` },
  ]);
  rows.push([{ text: "✏️ Custom timezone…", callback_data: "tz_custom" }]);
  rows.push([{ text: "❌ Cancel", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}