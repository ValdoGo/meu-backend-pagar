import express from 'express';
import { pagarGet, pagarPost } from './pagarClient.js';

const app = express();
app.use(express.json());

// Permite requisições do teu APK / Frontend (CORS básico)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polling ativo para verificar alteração de estado nas transações
async function aguardarAteConcluir(endpoint, maxTentativas = 18, intervaloMs = 10000) {
  for (let i = 0; i < maxTentativas; i++) {
    await sleep(intervaloMs);

    const data = await pagarGet(endpoint);
    const item = data.topup || data.payment || data.payout;

    console.log(`[Polling Render - Tentativa ${i + 1}/${maxTentativas}] Estado: ${item.status}`);

    if (item.status !== 'PROCESSING' && item.status !== 'PENDING') {
      return item;
    }
  }

  throw new Error('TIMEOUT: O tempo limite de resposta expirou sem confirmação.');
}

// --------------------------------------------------------------------------
// ROTA 0: ROTA DE SAÚDE / VERIFICAÇÃO DO SERVIDOR
// --------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'Backend Pagar API operacional no Render!' });
});

// --------------------------------------------------------------------------
// ROTA 1: CONSULTAR SALDO
// --------------------------------------------------------------------------
app.get('/api/carteira/saldo', async (req, res) => {
  try {
    const { wallet } = await pagarGet('/wallet');
    res.json({
      disponivelMzn: wallet.availableAmountMzn,
      reservadoMzn: wallet.reservedAmountMzn,
      currency: wallet.currency
    });
  } catch (error) {
    console.error('Erro ao consultar saldo:', error.message);
    res.status(500).json({ error: error.message, requestId: error.requestId });
  }
});

// --------------------------------------------------------------------------
// ROTA 2: CARREGAR A CARTEIRA (TOP-UP VIA M-PESA / EMOLA)
// --------------------------------------------------------------------------
app.post('/api/carteira/topup', async (req, res) => {
  try {
    const { amountMzn, method, phone, reference } = req.body;

    if (!amountMzn || amountMzn < 20 || amountMzn > 40000) {
      return res.status(400).json({ error: 'O valor deve estar entre 20 e 40 000 MZN' });
    }

    const ref = reference || `topup-${Date.now()}`;

    const { topup } = await pagarPost('/wallet/topups', {
      reference: ref,
      amountMzn: Math.floor(amountMzn),
      method: method,
      paymentPhone: phone,
    }, `topup:${ref}`);

    console.log(`Top-Up iniciado (ID: ${topup.id}). A aguardar confirmação do cliente...`);

    const resultadoFinal = await aguardarAteConcluir(`/wallet/topups/by-reference/${ref}`);

    if (resultadoFinal.status === 'PAID') {
      return res.json({
        sucesso: true,
        message: 'Recarga concluída e saldo creditado com sucesso!',
        topup: resultadoFinal
      });
    } else {
      return res.status(400).json({
        sucesso: false,
        message: `A recarga não foi concluída. Estado final: ${resultadoFinal.status}`,
        topup: resultadoFinal
      });
    }

  } catch (error) {
    console.error('Erro no fluxo de Top-up:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------------------------------
// ROTA 3: ENVIAR DINHEIRO / LEVANTAMENTO (PAYOUT B2C)
// --------------------------------------------------------------------------
app.post('/api/carteira/payout', async (req, res) => {
  try {
    const { amountMzn, method, recipientPhone, recipientName, reference } = req.body;

    if (!amountMzn || amountMzn < 20 || amountMzn > 40000) {
      return res.status(400).json({ error: 'O valor do levantamento deve ser entre 20 e 40 000 MZN' });
    }

    const ref = reference || `payout-${Date.now()}`;

    const { wallet } = await pagarGet('/wallet');
    if (wallet.availableAmountMzn < amountMzn) {
      return res.status(409).json({ error: 'Saldo insuficiente na carteira.' });
    }

    const { payout } = await pagarPost('/payouts', {
      reference: ref,
      description: `Levantamento de ${recipientName}`,
      amountMzn: Math.floor(amountMzn),
      method: method,
      recipient: {
        phone: recipientPhone,
        name: recipientName
      }
    }, `payout:${ref}`);

    console.log(`Payout iniciado (ID: ${payout.id}). A aguardar processamento...`);

    const resultadoFinal = await aguardarAteConcluir(`/payouts/${payout.id}`);

    if (resultadoFinal.status === 'PAID') {
      return res.json({
        sucesso: true,
        message: 'Transferência concluída com sucesso!',
        payout: resultadoFinal
      });
    } else {
      return res.status(400).json({
        sucesso: false,
        message: `O levantamento falhou. Estado final: ${resultadoFinal.status}`,
        payout: resultadoFinal
      });
    }

  } catch (error) {
    console.error('Erro no fluxo de Payout:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// O Render injeta automaticamente a variável PORT no ambiente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor a correr na porta ${PORT}`));