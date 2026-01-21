export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export interface Update {
  update_id: number;
  message?: any;
  callback_query?: any;
}