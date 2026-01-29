// Minimal Telegram Bot API client (no dependencies, plain fetch).

const API = "https://api.telegram.org";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function tgCall(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    const description = data?.description ?? `HTTP ${res.status}`;
    throw new Error(`Telegram ${method} failed: ${description}`);
  }
  return data.result;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<any> {
  return tgCall(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<any> {
  return tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<any> {
  const params: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) {
    params.text = text;
    params.show_alert = false;
  }
  return tgCall(token, "answerCallbackQuery", params);
}

export async function deleteMessage(token: string, chatId: number, messageId: number): Promise<void> {
  try {
    await tgCall(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // message already gone, too old to delete, or bot blocked — ignore
  }
}