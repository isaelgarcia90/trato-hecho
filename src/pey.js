import { config } from './config.js';
import { newId } from './store.js';

// Cliente mínimo del API de pey (https://docs.pey.mx/openapi.json).
//   POST /codi/qr  -> { id, qrString, qrImage }
//   POST /codi/pn  -> { transactionId, codiId }

async function call(pathname, body) {
  const res = await fetch(`${config.peyBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.peyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text || res.statusText;
    const err = new Error(`pey ${pathname} ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function base({ amount, concept, numRef, metadata }) {
  const body = {
    amount,
    concept: concept.slice(0, 40),
    numRef,
    metadata,
  };
  if (config.peyBankAccountId) body.bankAccountId = config.peyBankAccountId;
  return body;
}

export async function createQr(args, { simulated = config.peyMock } = {}) {
  if (simulated) {
    return { id: `MOCK-${newId()}`, qrString: `SIMULADO|${args.amount}|${args.concept}|${args.numRef}`, qrImage: null };
  }
  return call('/codi/qr', { ...base(args), expiration: 900 });
}

export async function createPush(args, { simulated = config.peyMock } = {}) {
  if (simulated) {
    return { transactionId: `MOCK-${newId()}`, codiId: '00000000000000000000' };
  }
  return call('/codi/pn', { ...base(args), phoneNumber: args.phoneNumber, expiration: 900 });
}
