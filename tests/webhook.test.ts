/**
 * Testes do extrator do webhook de entrada:
 *   - contrato generico {channel, groupId, text}
 *   - payload Evolution API v2 (messages.upsert)
 *   - filtros: evento errado, fromMe (anti-loop), conversa que nao e grupo
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractIncoming } from "../src/http/webhook.js";

test("extractIncoming: contrato generico", () => {
  const r = extractIncoming({ channel: "whatsapp", groupId: "G1", text: "/COTAR 25K USDT" });
  assert.equal(r.channel, "whatsapp");
  assert.equal(r.groupId, "G1");
  assert.equal(r.text, "/COTAR 25K USDT");
  assert.equal(r.ignore, undefined);
  assert.equal(r.isEvolution, false);
});

test("extractIncoming: canal via rota /webhook/:channel", () => {
  const r = extractIncoming({ groupId: "G1", text: "/AJUDA" }, "telegram");
  assert.equal(r.channel, "telegram");
});

const EVO_BASE = {
  event: "messages.upsert",
  instance: "talkbia",
  data: {
    key: { remoteJid: "120363999999999999@g.us", fromMe: false, id: "ABC" },
    pushName: "Fulano",
    message: { conversation: "/COTAR 25K USDT" },
  },
};

test("extractIncoming: Evolution messages.upsert com conversation", () => {
  const r = extractIncoming(EVO_BASE);
  assert.equal(r.isEvolution, true);
  assert.equal(r.ignore, undefined);
  assert.equal(r.channel, "whatsapp");
  assert.equal(r.groupId, "120363999999999999@g.us");
  assert.equal(r.text, "/COTAR 25K USDT");
});

test("extractIncoming: Evolution com extendedTextMessage (resposta/formatado)", () => {
  const payload = structuredClone(EVO_BASE) as Record<string, any>;
  payload.data.message = { extendedTextMessage: { text: "/COMPRAR" } };
  const r = extractIncoming(payload);
  assert.equal(r.text, "/COMPRAR");
});

test("extractIncoming: Evolution evento MESSAGES_UPSERT (maiusculo) aceito", () => {
  const payload = structuredClone(EVO_BASE) as Record<string, any>;
  payload.event = "MESSAGES_UPSERT";
  assert.equal(extractIncoming(payload).ignore, undefined);
});

test("extractIncoming: outros eventos Evolution sao ignorados", () => {
  const payload = structuredClone(EVO_BASE) as Record<string, any>;
  payload.event = "presence.update";
  assert.equal(extractIncoming(payload).ignore, "event");
});

test("extractIncoming: fromMe=true ignorado (anti-loop das proprias mensagens)", () => {
  const payload = structuredClone(EVO_BASE) as Record<string, any>;
  payload.data.key.fromMe = true;
  assert.equal(extractIncoming(payload).ignore, "from-me");
});

test("extractIncoming: conversa individual (nao-grupo) ignorada", () => {
  const payload = structuredClone(EVO_BASE) as Record<string, any>;
  payload.data.key.remoteJid = "5511999999999@s.whatsapp.net";
  assert.equal(extractIncoming(payload).ignore, "not-group");
});

test("extractIncoming: Evolution sem texto (midia) nao vira erro de payload", () => {
  const payload = structuredClone(EVO_BASE) as Record<string, any>;
  payload.data.message = { imageMessage: { caption: "" } };
  const r = extractIncoming(payload);
  assert.equal(r.ignore, undefined);
  assert.equal(r.text, null);
  assert.equal(r.isEvolution, true);
});
