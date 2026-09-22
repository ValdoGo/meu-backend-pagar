

const NETSHOP_BASE_URL = 'https://www.netshop.co.mz/api/v1';

// Mapeamento dinâmico do Wallet ID com base no método de pagamento
export function getWalletIdByMethod(method) {
  const met = (method || '').toLowerCase();
  
  if (met === 'mpesa') {
    return process.env.NETSHOP_WALLET_MPESA || '179454';
  }
  if (met === 'mcash' || met === 'emola') {
    return process.env.NETSHOP_WALLET_MCASH || '383886';
  }
  if (met === 'bci' || met === 'bank' || met === 'card') {
    return process.env.NETSHOP_WALLET_BCI || '254359';
  }

  // Wallet de reserva (fallback)
  return process.env.NETSHOP_WALLET_ID || '179454';
}

// Requisições GET com detalhamento de erros
export async function netshopGet(endpoint, walletId = null) {
  const apiKey = process.env.NETSHOP_API_KEY;
  const activeWallet = walletId || process.env.NETSHOP_WALLET_ID || '179454';

  const response = await fetch(`${NETSHOP_BASE_URL}${endpoint}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'X-Wallet-ID': activeWallet,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const detalhe = data.message || data.error || data.failed_reason || JSON.stringify(data);
    throw new Error(`[HTTP ${response.status}] ${detalhe}`);
  }

  return data;
}

// Requisições POST com detalhamento de erros e Idempotência
export async function netshopPost(endpoint, body, idempotencyKey = null, walletId = null) {
  const apiKey = process.env.NETSHOP_API_KEY;
  const activeWallet = walletId || process.env.NETSHOP_WALLET_ID || '179454';

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'X-Wallet-ID': activeWallet,
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
    const detalhe = data.message || data.error || data.failed_reason || JSON.stringify(data);
    throw new Error(`[HTTP ${response.status}] ${detalhe}`);
  }

  return data;
}
