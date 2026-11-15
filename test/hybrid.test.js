import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Modo automático: pey falso que primero rechaza ("CoDi not enabled") y luego acepta.
let codiEnabled = false;
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d)).on('end', () => {
    calls.push({ path: req.url, body: JSON.parse(body || '{}') });
    res.setHeader('content-type', 'application/json');
    if (!codiEnabled) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: 'API key does not have CoDi enabled', type: 'invalid_request' } }));
    }
    if (req.url === '/codi/qr') { res.statusCode = 201; return res.end(JSON.stringify({ id: 'IDC-1', qrString: 'REAL|QR', qrImage: null })); }
    res.end(JSON.stringify({ transactionId: 'TX-1', codiId: 'C-1' }));
  });
});

let agent, store, payments;
before(async () => {
  await new Promise(r => fake.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trato-hybrid-'));
  Object.assign(process.env, {
    DATA_FILE: path.join(dir, 'db.json'), PEY_MOCK: '', PEY_API_KEY: 'test-key',
    PEY_BASE_URL: `http://127.0.0.1:${fake.address().port}`, LLM_API_KEY: '',
    ALLOWED_PHONES: '5512345678', DEMO_CHARGE_AMOUNT: '0.01',
  });
  agent = await import('../src/agent.js');
  store = await import('../src/store.js');
  payments = await import('../src/payments.js');
});
after(() => fake.close());

async function quoteJob() {
  const job = store.createJob('tamales');
  agent.greet(job);
  await agent.handleClientMessage(job.id, { text: 'quiero 3 de rajas' });
  await agent.handleClientMessage(job.id, { text: '55 8765 4321' });
  return store.getJob(job.id);
}

test('pey rechaza: el cobro pasa a prueba y lo dice', async () => {
  const job = await quoteJob();
  const charge = await payments.chargeJob(job, 'pago', 'qr');
  assert.equal(charge.simulated, true);
  assert.equal(charge.testReason, 'pey');
  assert.match(charge.peyError, /CoDi enabled/);
  assert.ok(charge.qrDataUrl);
  assert.equal(payments.payMode(), 'auto-prueba');
  assert.equal(calls.at(-1).body.amount, 0.01);
});

test('celular no autorizado: push de prueba sin llamar a pey', async () => {
  codiEnabled = true;
  const before = calls.length;
  const job = await quoteJob();
  const charge = await payments.chargeJob(job, 'pago', 'push');
  assert.equal(charge.simulated, true);
  assert.equal(charge.testReason, 'phone');
  assert.equal(calls.length, before);
});

test('pey ya acepta: el siguiente cobro es real', async () => {
  codiEnabled = true;
  const job = await quoteJob();
  const charge = await payments.chargeJob(job, 'pago', 'qr');
  assert.equal(charge.simulated, false);
  assert.equal(charge.peyId, 'IDC-1');
  assert.equal(payments.payMode(), 'produccion');
});
