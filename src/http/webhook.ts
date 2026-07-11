/**
 * Webhook de entrada: mensagens dos grupos.
 *
 * Contratos aceitos:
 *
 * 1) Generico (integracoes proprias / testes):
 *    POST /webhook            { "channel": "whatsapp", "groupId": "...", "text": "/COTAR 25K USDT" }
 *    POST /webhook/:channel   { "groupId": "...", "text": "..." }
 *
 * 2) Evolution API v2 (evento MESSAGES_UPSERT):
 *    { "event": "messages.upsert", "instance": "talkbia",
 *      "data": { "key": { "remoteJid": "1203...@g.us", "fromMe": false },
 *                "message": { "conversation": "/COTAR ..." } } }
 *
 * Regras para payloads Evolution:
 *   - somente "messages.upsert" e processado (demais eventos: ignorados com 200);
 *   - mensagens do proprio bot (fromMe=true) sao ignoradas (evita loop);
 *   - somente grupos (remoteJid terminando em "@g.us") sao processados.
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

export interface ExtractedIncoming {
  channel: string | null;
  groupId: string | null;
  text: string | null;
  groupName?: string;
  /** Motivo para ignorar o payload silenciosamente (responder 200 sem processar). */
  ignore?: "event" | "from-me" | "not-group";
  /** true quando o payload tem formato Evolution (tem campo event/instance). */
  isEvolution: boolean;
}

export function extractIncoming(
  body: unknown,
  channelParam?: string,
): ExtractedIncoming {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = (b.data ?? {}) as Record<string, unknown>;
  const key = (data.key ?? {}) as Record<string, unknown>;
  const message = (data.message ?? {}) as Record<string, unknown>;
  const extended = (message.extendedTextMessage ?? {}) as Record<string, unknown>;

  const isEvolution = typeof b.event === "string" || typeof b.instance === "string";

  const base: Omit<ExtractedIncoming, "ignore"> = {
    channel: pickString(b.channel, channelParam, "whatsapp"),
    groupId: pickString(b.groupId, b.group_id, b.remoteJid, b.chatId, key.remoteJid),
    text: pickString(b.text, b.message, b.body, message.conversation, extended.text),
    groupName: pickString(b.groupName, b.group_name) ?? undefined,
    isEvolution,
  };

  if (isEvolution) {
    const event = String(b.event ?? "").toLowerCase().replace(/_/g, ".");
    if (event && event !== "messages.upsert") {
      return { ...base, ignore: "event" };
    }
    if (key.fromMe === true) {
      return { ...base, ignore: "from-me" };
    }
    const jid = pickString(key.remoteJid);
    // Fase atual: somente grupos (o descritivo cobre monitoramento de grupos).
    if (!pickString(b.groupId) && jid && !jid.endsWith("@g.us")) {
      return { ...base, ignore: "not-group" };
    }
  }

  return base;
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

    const incoming = extractIncoming(req.body, req.params.channel);

    if (incoming.ignore) {
      res.status(200).json({ handled: false, reason: incoming.ignore });
      return;
    }

    if (!incoming.groupId || !incoming.text) {
      // Payloads Evolution sem texto (midia, reacao, etc): ignorar sem erro
      // para nao gerar tempestade de retries no gateway.
      if (incoming.isEvolution) {
        res.status(200).json({ handled: false, reason: "no-text" });
        return;
      }
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
