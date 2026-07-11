/**
 * Envio de mensagens de volta ao grupo.
 *
 * Modos:
 *   - "evolution": Evolution API v2 — POST {base}/message/sendText/{instance}
 *                  com header apikey e body {number, text}. O groupId e o JID
 *                  do grupo (ex: 120363...@g.us).
 *   - "webhook":   POST generico em OUTBOUND_WEBHOOK_URL com {channel, groupId, text}.
 *   - "log":       apenas registra (desenvolvimento / homologacao).
 */

import axios from "axios";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

export interface OutboundMessage {
  channel: string;
  groupId: string;
  text: string;
}

export class OutboundSender {
  constructor(private readonly config: AppConfig) {}

  async send(message: OutboundMessage): Promise<boolean> {
    if (this.config.outboundMode === "evolution") {
      return this.sendViaEvolution(message);
    }
    if (this.config.outboundMode === "webhook" && this.config.outboundWebhookUrl) {
      return this.sendViaWebhook(message);
    }
    logger.info("Mensagem ao grupo (modo log)", {
      channel: message.channel,
      groupId: message.groupId,
      text: message.text,
    });
    return true;
  }

  private async sendViaEvolution(message: OutboundMessage): Promise<boolean> {
    const url = `${this.config.evolutionBaseUrl}/message/sendText/${encodeURIComponent(
      this.config.evolutionInstance as string,
    )}`;
    try {
      await axios.post(
        url,
        { number: message.groupId, text: message.text },
        {
          timeout: 15_000,
          headers: {
            "Content-Type": "application/json",
            apikey: this.config.evolutionApiKey as string,
          },
        },
      );
      return true;
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? `HTTP ${error.response?.status ?? "?"} ${JSON.stringify(error.response?.data ?? "")}`
        : String(error);
      logger.error("Falha ao enviar mensagem via Evolution API", {
        groupId: message.groupId,
        detail,
      });
      return false;
    }
  }

  private async sendViaWebhook(message: OutboundMessage): Promise<boolean> {
    try {
      await axios.post(this.config.outboundWebhookUrl as string, message, {
        timeout: 15_000,
        headers: {
          "Content-Type": "application/json",
          ...(this.config.outboundToken
            ? { Authorization: `Bearer ${this.config.outboundToken}` }
            : {}),
        },
      });
      return true;
    } catch (error) {
      logger.error("Falha ao enviar mensagem ao grupo (webhook)", {
        channel: message.channel,
        groupId: message.groupId,
        error: String(error),
      });
      return false;
    }
  }
}
