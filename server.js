import express from 'express';
import crypto from 'node:crypto';
import { netshopGet, netshopPost } from './netshopClient.js';

const app = express();
app.use(express.json());

// Permite requisições do teu APK / Frontend (CORS básico)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Wallet-ID, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polling ativo para verificar alteração de estado nas transações NetShop
async function aguardarAteConcluir(endpoint, maxTentativas = 18, intervaloMs = 10000) {
  for (let i = 0; i < maxTentativas; i++) {
    await sleep(intervaloMs);

    const data = await netshopGet(endpoint);
    // A NetShop devolve o objeto diretamente ou o próprio estado
    const status = data.status;

    console.log(`[Polling Render - Tentativa ${i + 1}/${maxTentativas}] Estado: ${status}`);

    if (status !== 'pending' && status !== 'PROCESSING') {
      return data;
    }
  }

  throw new Error('TIMEOUT: O tempo limite de resposta expirou sem confirmação.');
}

// --------------------------------------------------------------------------
// ROTA 0: HEALTH-CHECK DO SERVIDOR E VALIDAÇÃO DA NETSHOP BASE URL
// --------------------------------------------------------------------------
app.get('/', async (req, res) => {
  try {
    const ping = await netshopGet('/ping');
    res.json({
      status: 'online',
      message: 'Backend NetShop API operacional no Render!',
      netshopPing: ping
    });
  } catch (error) {
    res.json({ status: 'online', message: 'Backend a correr, mas com erro no ping NetShop', error: error.message });
  }
});

// --------------------------------------------------------------------------
// ROTA 1: CARREGAR A CARTEIRA / COBRANÇA (TOP-UP VIA M-PESA, EMOLA, MKESH OU CARD)
// --------------------------------------------------------------------------
app.post('/api/carteira/topup', async (req, res) => {
  try {
    const { amountMzn, method, phone, reference, email } = req.body;

    if (!amountMzn || amountMzn < 10) {
      return res.status(400).json({ error: 'O valor mínimo para cobrança é 10 MZN' });
    }

    const ref = reference || `topup-${Date.now()}`;
    const met = (method || 'mpesa').toLowerCase();

    // Formatação do número de telefone (NetShop exige formato internacional como +258...)
    let formattedPhone = phone ? phone.trim() : '';
    if (formattedPhone && !formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.startsWith('258') ? `+${formattedPhone}` : `+258${formattedPhone}`;
    }

    const payload = {
      amount: Math.floor(amountMzn),
      currency: 'MZN',
      method: met,
      reference: ref,
      metadata: { source: 'carteira_topup' }
    };

    if (met === 'card') {
      if (email) payload.customer_email = email;
    } else {
      payload.msisdn = formattedPhone;
    }

    const chargeResponse = await netshopPost('/charges', payload, ref);

    console.log(`Cobrança iniciada (ID: ${chargeResponse.id}). Estado inicial: ${chargeResponse.status}`);

    // Se for Cartão, devolve o link de checkout hospedado
    if (met === 'card' && chargeResponse.checkout) {
      return res.json({
        sucesso: true,
        requerRedirecionamento: true,
        checkoutUrl: chargeResponse.checkout.hosted_url,
        charge: chargeResponse
      });
    }

    // Se já foi pago síncronamente
    if (chargeResponse.status === 'paid') {
      return res.json({
        sucesso: true,
        message: 'Recarga concluída e saldo creditado com sucesso!',
        charge: chargeResponse
      });
    }

    // Se ficou em 'pending', aguarda via polling
    const resultadoFinal = await aguardarAteConcluir(`/charges/${chargeResponse.id}`);

    if (resultadoFinal.status === 'paid') {
      return res.json({
        sucesso: true,
        message: 'Recarga concluída e saldo creditado com sucesso!',
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
// ROTA 2: ENVIAR DINHEIRO / LEVANTAMENTO (PAYOUT B2C)
// --------------------------------------------------------------------------
app.post('/api/carteira/payout', async (req, res) => {
  try {
    const { amountMzn, method, recipientPhone, reference } = req.body;

    if (!amountMzn || amountMzn <= 0) {
      return res.status(400).json({ error: 'Informe um valor válido para o levantamento.' });
    }

    const ref = reference || `payout-${Date.now()}`;
    const met = (method || 'mpesa').toLowerCase();

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
      metadata: { purpose: 'levantamento_carteira' }
    }, ref);

    console.log(`Payout iniciado (ID: ${payoutResponse.id}). Estado: ${payoutResponse.status}`);

    if (payoutResponse.status === 'completed') {
      return res.json({
        sucesso: true,
        message: 'Transferência concluída com sucesso!',
        payout: payoutResponse
      });
    }

    const resultadoFinal = await aguardarAteConcluir(`/payouts/${payoutResponse.id}`);

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
// ROTA 3: RECEBER E VALIDAR WEBHOOKS DA NETSHOP
// --------------------------------------------------------------------------
app.post('/api/carteira/webhook', (req, res) => {
  try {
    const signatureHeader = req.headers['x-netshop-signature'];
    const webhookSecret = process.env.NETSHOP_WEBHOOK_SECRET;

    // Validação de segurança via HMAC SHA-256
    if (webhookSecret) {
      if (!signatureHeader) {
        console.warn('⚠️ Webhook rejeitado: Cabeçalho X-NetShop-Signature ausente.');
        return res.status(401).json({ error: 'Assinatura ausente' });
      }

      const rawBody = JSON.stringify(req.body);
      const computedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      // Validação timingSafeEqual para prevenção contra timing attacks
      const signatureBuffer = Buffer.from(signatureHeader, 'utf8');
      const computedBuffer = Buffer.from(computedSignature, 'utf8');

      if (signatureBuffer.length !== computedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, computedBuffer)) {
        console.error('❌ Webhook rejeitado: Assinatura NetShop HMAC inválida!');
        return res.status(401).json({ error: 'Assinatura inválida' });
      }
    }

    const evento = req.body;
    console.log('🔔 Webhook Autêntico Recebido da NetShop:', JSON.stringify(evento, null, 2));

    const { event, data } = evento;

    // Eventos enviados pela NetShop
    if (event === 'charge.paid') {
      console.log(`✅ Cobrança ${data?.id || data?.reference} PAGA com sucesso!`);
    } else if (event === 'charge.failed') {
      console.log(`❌ Cobrança ${data?.id || data?.reference} FALHOU.`);
    } else if (event === 'payout.completed') {
      console.log(`✅ Payout ${data?.id || data?.reference} CONCLUÍDO com sucesso!`);
    } else if (event === 'payout.failed') {
      console.log(`❌ Payout ${data?.id || data?.reference} FALHOU.`);
    }

    res.status(200).json({ status: 'success', message: 'Webhook NetShop processado com sucesso' });

  } catch (error) {
    console.error('Erro ao processar Webhook NetShop:', error.message);
    res.status(500).json({ error: 'Erro interno ao processar Webhook' });
  }
});

// O Render injeta automaticamente a variável PORT no ambiente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor NetShop a correr na porta ${PORT}`));
