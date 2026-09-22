import express from 'express';
import crypto from 'node:crypto';
import { netshopGet, netshopPost, getWalletIdByMethod } from './netshopClient.js';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Wallet-ID, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polling dinâmico enviando o walletId correspondente
async function aguardarAteConcluir(endpoint, walletId, maxTentativas = 18, intervaloMs = 10000) {
  for (let i = 0; i < maxTentativas; i++) {
    await sleep(intervaloMs);

    const data = await netshopGet(endpoint, walletId);
    const status = data.status;

    console.log(`[Polling NetShop - Tentativa ${i + 1}/${maxTentativas}] Wallet: ${walletId} | Estado: ${status}`);

    if (status !== 'pending' && status !== 'PROCESSING') {
      return data;
    }
  }

  throw new Error('TIMEOUT: O tempo limite de resposta expirou sem confirmação.');
}

// --------------------------------------------------------------------------
// ROTA 0: HEALTH CHECK
// --------------------------------------------------------------------------
app.get('/', async (req, res) => {
  try {
    const ping = await netshopGet('/ping');
    res.json({
      status: 'online',
      message: 'Backend NetShop API operacional no Render com suporte a múltiplas carteiras!',
      netshopPing: ping
    });
  } catch (error) {
    res.json({ status: 'online', message: 'Backend a correr com aviso no ping', error: error.message });
  }
});

// --------------------------------------------------------------------------
// ROTA 1: COBRANÇA / RECARGA DA CARTEIRA (TOP-UP)
// --------------------------------------------------------------------------
app.post('/api/carteira/topup', async (req, res) => {
  try {
    const { amountMzn, method, phone, reference, email } = req.body;

    if (!amountMzn || amountMzn < 10) {
      return res.status(400).json({ error: 'O valor mínimo para cobrança é 10 MZN' });
    }

    const ref = reference || `topup-${Date.now()}`;
    const met = (method || 'mpesa').toLowerCase();

    // Seleciona a Wallet adequada com base no método
    const activeWallet = getWalletIdByMethod(met);

    let formattedPhone = phone ? phone.trim() : '';
    if (formattedPhone && !formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.startsWith('258') ? `+${formattedPhone}` : `+258${formattedPhone}`;
    }

    const payload = {
      amount: Math.floor(amountMzn),
      currency: 'MZN',
      method: met,
      reference: ref,
      metadata: { source: 'carteira_topup', wallet_used: activeWallet }
    };

    if (met === 'card' || met === 'bci') {
      if (email) payload.customer_email = email;
    } else {
      payload.msisdn = formattedPhone;
    }

    // Passa a carteira selecionada como 4º argumento
    const chargeResponse = await netshopPost('/charges', payload, ref, activeWallet);

    console.log(`Cobrança iniciada na Wallet [${activeWallet}] (ID: ${chargeResponse.id}). Estado: ${chargeResponse.status}`);

    if ((met === 'card' || met === 'bci') && chargeResponse.checkout) {
      return res.json({
        sucesso: true,
        requerRedirecionamento: true,
        checkoutUrl: chargeResponse.checkout.hosted_url,
        charge: chargeResponse
      });
    }

    if (chargeResponse.status === 'paid') {
      return res.json({
        sucesso: true,
        message: 'Recarga concluída e saldo creditado!',
        charge: chargeResponse
      });
    }

    const resultadoFinal = await aguardarAteConcluir(`/charges/${chargeResponse.id}`, activeWallet);

    if (resultadoFinal.status === 'paid') {
      return res.json({
        sucesso: true,
        message: 'Recarga concluída e saldo creditado!',
        charge: resultadoFinal
      });
    } else {
      return res.status(400).json({
        sucesso: false,
        message: `A recarga falhou. Razão: ${resultadoFinal.failed_reason || resultadoFinal.status}`,
        charge: resultadoFinal
      });
    }

  } catch (error) {
    console.error('Erro no fluxo de Top-up NetShop:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------------------------------
// ROTA 2: LEVANTAMENTO / TRANSFERÊNCIA (PAYOUT)
// --------------------------------------------------------------------------
app.post('/api/carteira/payout', async (req, res) => {
  try {
    const { amountMzn, method, recipientPhone, reference } = req.body;

    if (!amountMzn || amountMzn <= 0) {
      return res.status(400).json({ error: 'Informe um valor válido para o levantamento.' });
    }

    const ref = reference || `payout-${Date.now()}`;
    const met = (method || 'mpesa').toLowerCase();

    // Seleciona a Wallet adequada
    const activeWallet = getWalletIdByMethod(met);

    let formattedPhone = recipientPhone ? recipientPhone.trim() : '';
    if (formattedPhone && !formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.startsWith('258') ? `+${formattedPhone}` : `+258${formattedPhone}`;
    }

    const payoutResponse = await netshopPost('/payouts', {
      amount: Math.floor(amountMzn),
      currency: 'MZN',
      method: met,
      msisdn: formattedPhone,
      reference: ref,
      metadata: { purpose: 'levantamento_carteira', wallet_used: activeWallet }
    }, ref, activeWallet);

    console.log(`Payout iniciado na Wallet [${activeWallet}] (ID: ${payoutResponse.id}). Estado: ${payoutResponse.status}`);

    if (payoutResponse.status === 'completed') {
      return res.json({
        sucesso: true,
        message: 'Transferência concluída com sucesso!',
        payout: payoutResponse
      });
    }

    const resultadoFinal = await aguardarAteConcluir(`/payouts/${payoutResponse.id}`, activeWallet);

    if (resultadoFinal.status === 'completed') {
      return res.json({
        sucesso: true,
        message: 'Transferência concluída com sucesso!',
        payout: resultadoFinal
      });
    } else {
      return res.status(400).json({
        sucesso: false,
        message: `O levantamento falhou. Razão: ${resultadoFinal.failed_reason || resultadoFinal.status}`,
        payout: resultadoFinal
      });
    }

  } catch (error) {
    console.error('Erro no fluxo de Payout NetShop:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------------------------------
// ROTA 3: WEBHOOK NETSHOP
// --------------------------------------------------------------------------
app.post('/api/carteira/webhook', (req, res) => {
  try {
    const signatureHeader = req.headers['x-netshop-signature'];
    const webhookSecret = process.env.NETSHOP_WEBHOOK_SECRET;

    if (webhookSecret) {
      if (!signatureHeader) {
        return res.status(401).json({ error: 'Assinatura ausente' });
      }

      const rawBody = JSON.stringify(req.body);
      const computedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      const signatureBuffer = Buffer.from(signatureHeader, 'utf8');
      const computedBuffer = Buffer.from(computedSignature, 'utf8');

      if (signatureBuffer.length !== computedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, computedBuffer)) {
        return res.status(401).json({ error: 'Assinatura inválida' });
      }
    }

    const evento = req.body;
    console.log('🔔 Webhook Autêntico Recebido da NetShop:', JSON.stringify(evento, null, 2));

    res.status(200).json({ status: 'success', message: 'Webhook recebido com sucesso' });

  } catch (error) {
    console.error('Erro ao processar Webhook NetShop:', error.message);
    res.status(500).json({ error: 'Erro interno ao processar Webhook' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor NetShop ativo na porta ${PORT}`));
