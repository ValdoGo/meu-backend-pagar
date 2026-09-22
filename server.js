import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { netshopPost, netshopGet, getWalletIdByMethod } from './netshopClient.js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// 1. ROTA DO WEBHOOK (Validação HMAC usando o corpo bruto/rawBody)
app.post('/api/webhook/netshop', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-netshop-signature'];
  const secret = process.env.NETSHOP_WEBHOOK_SECRET;

  if (secret && signature) {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(req.body)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('❌ Webhook rejeitado: Assinatura NetShop HMAC inválida!');
      return res.status(401).json({ error: 'Assinatura inválida' });
    }
  }

  try {
    const payload = JSON.parse(req.body.toString());
    console.log('✅ Webhook NetShop recebido:', payload.event || payload);
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    return res.status(400).json({ error: 'Payload JSON inválido' });
  }
});

// Middleware JSON para as restantes rotas
app.use(express.json());

// Health Check / Teste de Estado
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Servidor NetShop Ativo' });
});

// 2. ROTA DE DEPÓSITO / COBRANÇA (TOP-UP)
app.post('/api/carteira/topup', async (req, res) => {
  try {
    const { method, phone, email, amountMzn } = req.body;

    // Normaliza o método ("bci" -> "card")
    const normalizedMethod = (method === 'bci') ? 'card' : (method || '').toLowerCase();
    const walletId = getWalletIdByMethod(normalizedMethod);

    const payload = {
      amount: Number(amountMzn),
      currency: 'MZN',
      method: normalizedMethod,
      reference: `DEP_${Date.now()}`
    };

    // Formatação para Carteiras Móveis (M-Pesa, eMola, mKesh)
    if (['mpesa', 'emola', 'mkesh', 'mcash'].includes(normalizedMethod)) {
      if (!phone) {
        return res.status(400).json({ sucesso: false, error: 'O número de telefone é obrigatório para carteiras móveis.' });
      }

      let cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.startsWith('258')) {
        cleanPhone = cleanPhone.substring(3);
      }
      
      payload.msisdn = `+258${cleanPhone}`; // Formato obrigatório: +258XXXXXXXXX
    }

    // Formatação para Cartão (Visa / Mastercard / BCI)
    if (normalizedMethod === 'card') {
      if (!email) {
        return res.status(400).json({ sucesso: false, error: 'O e-mail é obrigatório para pagamentos com cartão.' });
      }
      payload.customer_email = email;
    }

    // Dispara requisição para POST /charges na NetShop
    const result = await netshopPost('/charges', payload, null, walletId);

    // Extrai o link de checkout hospedado (caso exista na resposta da NetShop)
    const checkoutUrl = result.checkout?.hosted_url || result.checkout?.url || null;

    if (normalizedMethod === 'card' && checkoutUrl) {
      return res.json({
        sucesso: true,
        requerRedirecionamento: true,
        checkoutUrl: checkoutUrl,
        message: 'Redirecionando para a tela de checkout...',
        data: result
      });
    }

    return res.json({
      sucesso: true,
      requerRedirecionamento: false,
      message: 'Cobrança iniciada! Confirme no telemóvel.',
      data: result
    });

  } catch (error) {
    console.error('❌ Erro no Topup:', error.message);
    return res.status(400).json({
      sucesso: false,
      error: error.message
    });
  }
});

// 3. ROTA DE LEVANTAMENTO (PAYOUT)
app.post('/api/carteira/payout', async (req, res) => {
  try {
    const { method, recipientPhone, amountMzn } = req.body;

    const normalizedMethod = (method || '').toLowerCase();

    // Em Payouts, usamos a Carteira Principal B2C (ou process.env.NETSHOP_MAIN_WALLET_ID)
    // Se passar um Wallet ID incompatível de cobrança C2B, a API gera 403 wallet_id_mismatch
    const walletId = process.env.NETSHOP_MAIN_WALLET_ID || getWalletIdByMethod('main') || null;

    let cleanPhone = (recipientPhone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('258')) {
      cleanPhone = cleanPhone.substring(3);
    }

    const payload = {
      amount: Number(amountMzn),
      currency: 'MZN',
      method: normalizedMethod, // mpesa | emola
      msisdn: `+258${cleanPhone}`,
      reference: `PAY_${Date.now()}`
    };

    // Dispara requisição para POST /payouts na NetShop
    const result = await netshopPost('/payouts', payload, null, walletId);

    return res.json({
      sucesso: true,
      message: 'Levantamento processado com sucesso!',
      data: result
    });

  } catch (error) {
    console.error('❌ Erro no Payout:', error.message);

    let mensagemAmigavel = error.message;

    // Trata erros de Wallet ID incompatível / B2C bloqueado
    if (error.message.includes('403') || error.message.includes('wallet_id_mismatch') || error.message.includes('b2c disabled')) {
      mensagemAmigavel = 'Erro de permissão (HTTP 403): O Wallet ID utilizado não possui a função B2C/Payout ativa na NetShop ou não corresponde à conta principal.';
    } else if (error.message.includes('422') || error.message.includes('insufficient_balance')) {
      mensagemAmigavel = 'Saldo insuficiente na carteira NetShop para realizar o levantamento.';
    }

    return res.status(400).json({
      sucesso: false,
      error: mensagemAmigavel
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor NetShop ativo na porta ${PORT}`);
});
