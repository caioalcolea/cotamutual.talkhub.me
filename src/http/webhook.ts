/**
 * Webhook de entrada: mensagens dos grupos.
 *
 * Contrato principal:
 *   POST /webhook            { "channel": "whatsapp", "groupId": "...", "text": "/COTAR 25K USDT" }
 *   POST /webhook/:channel   { "groupId": "...", "text": "..." }
 *
 * Aceita aliases comuns de gateways (message/body, group_id/remoteJid/chatId,
 * data.message.conversation) para facilitar a integracao.
 */

import { Router, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import type { MessageProcessor } from "../core/processor.js";
import { logger } from "../logger.js";

function pickString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

function extractIncoming(req: Request): {
  channel: string | null;
  groupId: string | null;
  text: string | null;
  groupName?: string;
} {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const key = (data.key ?? {}) as Record<string, unknown>;
  const message = (data.message ?? {}) as Record<string, unknown>;

  return {
    channel: pickString(body.channel, req.params.channel, "whatsapp"),
    groupId: pickString(body.groupId, body.group_id, body.remoteJid, body.chatId, key.remoteJid),
    text: pickString(body.text, body.message, body.body, message.conversation),
    groupName: pickString(body.groupName, body.group_name, data.pushName) ?? undefined,
  };
}

export function createWebhookRouter(config: AppConfig, processor: MessageProcessor): Router {
  const router = Router();

  const guard = (req: Request, res: Response): boolean => {
    if (!config.webhookToken) return true;
    const header = req.headers["authorization"];
    const query = typeof req.query.token === "string" ? req.query.token : null;
    if (header === `Bearer ${config.webhookToken}` || query === config.webhookToken) {
      return true;
    }
    res.status(401).json({ error: "Não autorizado." });
    return false;
  };

  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!guard(req, res)) return;

    const incoming = extractIncoming(req);
    if (!incoming.groupId || !incoming.text) {
      res.status(400).json({
        error: "Payload inválido. Esperado: { channel, groupId, text }.",
      });
      return;
    }

    try {
      const outcome = await processor.handle({
        channel: incoming.channel ?? "whatsapp",
        groupId: incoming.groupId,
        text: incoming.text,
        groupName: incoming.groupName,
      });
      res.status(200).json(outcome);
    } catch (error) {
      logger.error("Falha ao processar webhook", { error: String(error) });
      res.status(500).json({ error: "Falha interna ao processar a mensagem." });
    }
  };

  router.post("/webhook", handler);
  router.post("/webhook/:channel", handler);

  return router;
}
