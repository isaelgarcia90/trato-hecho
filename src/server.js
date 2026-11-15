import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Webhook } from 'standardwebhooks';
import { config } from './config.js';
import { brand, businesses, defaultBusiness, getBusiness, publicBusiness } from './catalog.js';
import { greet, handleClientMessage } from './agent.js';
import { businessFor, chargeJob, handlePaymentEvent, money, notifyJob, publicJob, say } from './payments.js';
import { createJob, getCharge, getJob, listJobs, newId, updateJob } from './store.js';
import { subscribe } from './events.js';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'public');

// ---------- Webhook de pey (cuerpo crudo para verificar la firma) ----------
function makeVerifier(secret) {
  if (!secret) return null;
  try {
    return new Webhook(secret);
  } catch {
    // Si el secreto no viene en base64 / con prefijo whsec_, lo codificamos.
    return new Webhook(Buffer.from(secret).toString('base64'));
  }
}
const verifier = makeVerifier(config.peyWebhookSecret);

app.post('/webhooks/pey', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const payload = req.body.toString('utf8');
  let evt;
  try {
    if (verifier) {
      evt = verifier.verify(payload, {
        'webhook-id': req.header('webhook-id'),
        'webhook-timestamp': req.header('webhook-timestamp'),
        'webhook-signature': req.header('webhook-signature'),
      });
    } else if (config.peyMock) {
      evt = JSON.parse(payload); // solo en modo simulado se aceptan webhooks sin firma
    } else {
      console.error('[webhook] Falta PEY_WEBHOOK_SECRET; rechazado');
      return res.status(500).json({ error: 'webhook secret not configured' });
    }
  } catch (err) {
    console.warn('[webhook] firma inválida:', err.message);
    return res.status(400).json({ error: 'invalid signature' });
  }

  if (!['codi.qr.payment_received', 'codi.pn.payment_received'].includes(evt.type)) {
    return res.status(200).json({ ignored: evt.type });
  }
  const result = handlePaymentEvent(evt, req.header('webhook-id') || evt.transactionId);
  console.log('[webhook]', evt.type, evt.transactionId, result);
  // Siempre 200 para un evento válido, aunque no coincida, para evitar reintentos infinitos.
  res.status(200).json(result);
});

app.use(express.json({ limit: '100kb' }));

// ---------- Protección opcional del panel ----------
function panelAuth(req, res, next) {
  if (!config.panelPassword) return next();
  const [, b64] = (req.header('authorization') || '').split(' ');
  const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (pass === config.panelPassword) return next();
  res.set('WWW-Authenticate', 'Basic realm="Panel del negocio"').status(401).send('Acceso restringido');
}
app.get(['/panel', '/panel.html'], panelAuth, (req, res) => res.sendFile(path.join(publicDir, 'panel.html')));
app.use(express.static(publicDir, { index: 'index.html' }));
app.get('/chat', (req, res) => res.sendFile(path.join(publicDir, 'chat.html')));

// ---------- API del cliente ----------
app.get('/api/status', (req, res) => {
  res.json({
    brand,
    businesses: businesses.map(publicBusiness),
    mode: config.peyMock ? 'simulado' : 'produccion',
    demoChargeAmount: config.demoChargeAmount,
    llm: Boolean(config.llmApiKey),
  });
});

app.post('/api/jobs', (req, res) => {
  const business = getBusiness(req.body?.businessId) || defaultBusiness;
  const job = createJob(business.id);
  greet(job);
  notifyJob(job.id);
  res.status(201).json(publicJob(getJob(job.id)));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/messages', async (req, res) => {
  const { text, action } = req.body || {};
  if (!getJob(req.params.id)) return res.status(404).json({ error: 'not found' });
  if (!text && !action) return res.status(400).json({ error: 'text o action requerido' });
  try {
    await handleClientMessage(req.params.id, {
      text: typeof text === 'string' ? text.slice(0, 1000) : undefined,
      action: typeof action === 'string' ? action : undefined,
    });
    res.json(publicJob(getJob(req.params.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events', (req, res) => {
  const { jobId } = req.query;
  if (jobId) return subscribe(req, res, e => e.jobId === jobId);
  return panelAuth(req, res, () => subscribe(req, res, () => true));
});

// ---------- API del panel del negocio ----------
app.get('/api/panel/jobs', panelAuth, (req, res) => {
  res.json(listJobs().filter(j => j.messages.length > 1).map(publicJob));
});

app.post('/api/panel/jobs/:id/extras', panelAuth, (req, res) => {
  const job = getJob(req.params.id);
  const amount = Number(req.body?.amount);
  const concept = String(req.body?.concept || '').slice(0, 80);
  if (!job || !job.quote) return res.status(400).json({ error: 'El trabajo no tiene cotización' });
  if (!concept || !(amount > 0)) return res.status(400).json({ error: 'Concepto y monto > 0 requeridos' });
  updateJob(job.id, { extras: [...job.extras, { id: newId(), concept, amount }] });
  say(job.id, 'agente', `${businessFor(job).owner} agregó a tu cuenta: ${concept} (${money(amount)}).`);
  notifyJob(job.id);
  res.json(publicJob(getJob(job.id)));
});

app.post('/api/panel/jobs/:id/charge', panelAuth, async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const method = req.body?.method === 'qr' ? 'qr' : 'push';
  try {
    const charge = await chargeJob(job, 'restante', method);
    say(job.id, 'agente', method === 'push'
      ? `Te mandé el cobro de lo que resta, ${money(charge.quotedAmount)}, a tu app del banco.`
      : `Escanea este QR para pagar lo que resta, ${money(charge.quotedAmount)}:`,
    { kind: 'charge', chargeId: charge.id, method, amount: charge.quotedAmount, qrDataUrl: charge.qrDataUrl, simulated: charge.simulated });
    res.json(publicJob(getJob(job.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Solo modo simulado: simular que el cliente pagó ----------
app.post('/api/dev/simulate-payment/:chargeId', (req, res) => {
  if (!config.peyMock) return res.status(403).json({ error: 'Solo disponible en modo simulado' });
  const c = getCharge(req.params.chargeId);
  if (!c) return res.status(404).json({ error: 'not found' });
  const evt = {
    type: c.method === 'push' ? 'codi.pn.payment_received' : 'codi.qr.payment_received',
    amount: c.chargedAmount, transactionId: c.peyTransactionId || `MOCK-TX-${c.id}`,
    codiQrId: c.peyId, numRef: c.numRef, datePaid: Math.floor(Date.now() / 1000),
    concept: c.concept, metadata: { externalMetadata: { chargeId: c.id } },
  };
  res.json(handlePaymentEvent(evt, `sim-${c.id}`));
});

app.listen(config.port, () => {
  console.log(`${brand.name} en http://localhost:${config.port}  (pey: ${config.peyMock ? 'SIMULADO' : 'producción'}, LLM: ${config.llmApiKey ? config.llmModel : 'reglas'})`);
});
