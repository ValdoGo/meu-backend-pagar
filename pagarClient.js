import crypto from 'node:crypto';

// Lê variáveis de ambiente injetadas no Render ou localmente
const API_URL = process.env.PAGAR_API_BASE_URL || 'https://api.pagar.co.mz/api/v1';
const API_KEY = process.env.PAGAR_API_KEY;
const SIGNING_SECRET = process.env.PAGAR_SIGNING_SECRET;

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || 'Pedido rejeitado pela Pagar API');
    error.code = data.error;
    error.requestId = data.requestId;
    throw error;
  }
  return data;
}

// Consulta de Dados (GET)
export async function pagarGet(path) {
  const response = await fetch(API_URL + path, {
    method: 'GET',
    headers: { 
      'Authorization': 'Bearer ' + API_KEY,
      'Content-Type': 'application/json'
    },
  });
  return readResponse(response);
}

// Transações Financeiras (POST) - HMAC SHA-256 + Idempotência
export async function pagarPost(path, body, idempotencyKey) {
  if (!API_KEY || !SIGNING_SECRET) {
    throw new Error('Chaves PAGAR_API_KEY ou PAGAR_SIGNING_SECRET não estão configuradas.');
  }

  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(18).toString('base64url');
  const rawBody = JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const url = API_URL + path;
  const canonicalPath = new URL(url).pathname;

  const canonical = [timestamp, nonce, 'POST', canonicalPath, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET)
    .update(canonical).digest('hex');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Pagar-Timestamp': timestamp,
      'X-Pagar-Nonce': nonce,
      'X-Pagar-Signature': 'v1=' + signature,
    },
    body: rawBody,
  });
  return readResponse(response);
}