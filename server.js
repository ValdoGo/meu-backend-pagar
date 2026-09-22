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

    // Converte o método "bci" vindo do frontend para "card", exigido pela NetShop
    const normalizedMethod = (method === 'bci') ? 'card' : (method || '').toLowerCase();
    const walletId = getWalletIdByMethod(normalizedMethod);

    // Estrutura base do payload de acordo com a documentação
    const payload = {
      amount: Number(amountMzn),
      currency: 'MZN',
      method: normalizedMethod,
      reference: `DEP_${Date.now()}`
    };

    // Formatação de carteiras móveis (mpesa, emola, mkesh)
    if (['mpesa', 'emola', 'mkesh', 'mcash'].includes(normalizedMethod)) {
      if (!phone) {
        return res.status(400).json({ sucesso: false, error: 'O número de telefone é obrigatório para carteiras móveis.' });
      }

      // Limpa caracteres e garante prefixo +258
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

    const isHosted = result.checkout && result.checkout.type === 'hosted_url';
    const redirectUrl = isHosted ? result.checkout.hosted_url : null;

    return res.json({
      sucesso: true,
      message: isHosted ? 'Redirecionando para o Checkout...' : 'Cobrança iniciada! Confirme no telemóvel.',
      checkoutUrl: redirectUrl,
      requerRedirecionamento: !!redirectUrl,
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
    const walletId = getWalletIdByMethod(normalizedMethod);

    let cleanPhone = (recipientPhone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('258')) {
      cleanPhone = cleanPhone.substring(3);
    }

    const payload = {
      amount: Number(amountMzn),
      currency: 'MZN',
      method: normalizedMethod,
      msisdn: `+258${cleanPhone}`,
      reference: `PAY_${Date.now()}`
    };

    const result = await netshopPost('/payouts', payload, null, walletId);

    return res.json({
      sucesso: true,
      message: 'Levantamento processado com sucesso!',
      data: result
    });

  } catch (error) {
    console.error('❌ Erro no Payout:', error.message);
    return res.status(400).json({
      sucesso: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor NetShop ativo na porta ${PORT}`);
});
