// pagarClient.js (ou netshopClient.js)
import fetch from 'node-fetch';

const NETSHOP_BASE_URL = 'https://www.netshop.co.mz/api/v1';

// Função auxiliar para fazer chamadas GET à NetShop
export async function netshopGet(endpoint) {
  const apiKey = process.env.NETSHOP_API_KEY;
  const walletId = process.env.NETSHOP_WALLET_ID;

  const response = await fetch(`${NETSHOP_BASE_URL}${endpoint}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'X-Wallet-ID': walletId,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || 'Erro na requisição NetShop');
  }
  return data;
}

// Função auxiliar para fazer chamadas POST à NetShop
export async function netshopPost(endpoint, body, idempotencyKey = null) {
  const apiKey = process.env.NETSHOP_API_KEY;
  const walletId = process.env.NETSHOP_WALLET_ID;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'X-Wallet-ID': walletId,
    'Content-Type': 'application/json'
  };

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(`${NETSHOP_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || data.error || 'Erro na requisição NetShop');
  }
  return data;
}
