// Cloudflare Worker entry point: webhook + cron scheduled handler.

import type { Env, Update } from "./types";
import { handleUpdate } from "./bot";
import { runCron } from "./cron";
import { handleApi } from "./web";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const update = (await request.json()) as Update;
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    if (url.pathname === "/health") {
      return new Response("ReminderBot is alive ✅");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};