/**
 * Envio de mensagens de volta ao grupo.
 *
 * Modos:
 *   - "webhook": POST em OUTBOUND_WEBHOOK_URL com {channel, groupId, text}.
 *                Integra com o gateway do canal (ex: Evolution API / TalkHub).
 *   - "log":     apenas registra (desenvolvimento / homologacao).
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
    if (this.config.outboundMode === "log" || !this.config.outboundWebhookUrl) {
      logger.info("Mensagem ao grupo (modo log)", {
        channel: message.channel,
        groupId: message.groupId,
        text: message.text,
      });
      return true;
    }

    try {
      await axios.post(this.config.outboundWebhookUrl, message, {
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
      logger.error("Falha ao enviar mensagem ao grupo", {
        channel: message.channel,
        groupId: message.groupId,
        error: String(error),
      });
      return false;
    }
  }
}
