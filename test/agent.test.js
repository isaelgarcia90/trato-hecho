import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Conversaciones completas contra el agente real, en modo simulado y sin LLM.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trato-'));
Object.assign(process.env, {
  DATA_FILE: path.join(dir, 'db.json'), PEY_MOCK: '1', PEY_API_KEY: '', LLM_API_KEY: '',
  ALLOWED_PHONES: '', DEMO_CHARGE_AMOUNT: '',
});

let agent, store, nlu;
before(async () => {
  agent = await import('../src/agent.js');
  store = await import('../src/store.js');
  nlu = await import('../src/nlu.js');
});

async function chat(businessId, ...turns) {
  const job = store.createJob(businessId);
  agent.greet(job);
  for (const t of turns) await agent.handleClientMessage(job.id, typeof t === 'string' ? { text: t } : t);
  return store.getJob(job.id);
}
const last = job => job.messages.at(-1);

test('nlu: cantidades, celulares y texto sin sentido', () => {
  assert.equal(nlu.parseQuantity('quiero una docena'), 12);
  assert.equal(nlu.parseQuantity('media docena porfa'), 6);
  assert.equal(nlu.parseQuantity('dame diez'), 10);
  assert.equal(nlu.parsePhone('mi cel es 55 1234-5678'), '5512345678');
  assert.equal(nlu.parsePhone('+52 55 1234 5678'), '5512345678');
  assert.equal(nlu.parsePhone('5512'), null);
  assert.ok(nlu.isGibberish('asdfghjk'));
  assert.ok(nlu.isGibberish('???'));
  assert.ok(nlu.isGibberish('xkcdzt bvnmrt'));
  assert.ok(!nlu.isGibberish('se me tapó el baño'));
  assert.ok(!nlu.isUsefulDetail('no sé'));
  assert.ok(nlu.isUsefulDetail('la llave de la cocina gotea'));
});

test('flujo feliz con texto libre: plomería', async () => {
  const job = await chat('plomeria', 'se me tapó el baño desde ayer en la noche', 'mañana en la tarde', 'Morelos 45, col. Centro', '55 1234 5678');
  assert.equal(job.itemId, 'destape');
  assert.match(job.slot, /16:00/);
  assert.equal(job.phone, '5512345678');
  assert.equal(last(job).kind, 'quote');
});

test('texto sin sentido: pide una respuesta válida', async () => {
  const job = await chat('plomeria', 'asdkjhqwe zxcvb');
  assert.equal(job.itemId, null);
  assert.match(last(job).text, /no te entendí/i);
  assert.ok(last(job).buttons.length > 0);
});

test('algo que el negocio no ofrece: lo dice y muestra opciones', async () => {
  const job = await chat('plomeria', 'quiero una pizza hawaiana');
  assert.match(last(job).text, /No encontré «quiero una pizza hawaiana»/);
});

test('detalle insuficiente: explica qué necesita', async () => {
  const job = await chat('plomeria', { action: 'item:fuga', text: 'Reparación de fuga' }, 'no sé');
  assert.equal(job.description, null);
  assert.match(last(job).text, /necesito un poco más de detalle/i);
});

test('celular inválido: dice cuántos dígitos faltan', async () => {
  const job = await chat('tamales', 'quiero 10 tamales verdes', '55 1234');
  assert.equal(job.quantity, 10);
  assert.equal(job.phone, null);
  assert.match(last(job).text, /tiene 6 dígitos/);
});

test('preguntas en medio del flujo: responde y retoma', async () => {
  const job = await chat('dental', '¿cuánto cuesta?');
  assert.match(job.messages.at(-1).text, /Limpieza dental: \$700\.00/);
  const job2 = await chat('barberia', 'corte y barba', '¿a qué hora abren?');
  assert.equal(job2.itemId, 'combo');
  assert.match(last(job2).text, /Lun a sáb/);
  assert.match(last(job2).text, /horario/);
});

test('cantidad fuera de rango y por palabras', async () => {
  const job = await chat('postres', 'quiero galletas', 'una docena');
  assert.equal(job.quantity, 12);
  const big = await chat('tamales', 'quiero 500 tamales verdes');
  assert.equal(big.quantity, null);
  assert.match(last(big).text, /hasta 99/);
});

test('después de dos malentendidos ofrece hablar con el negocio', async () => {
  const job = await chat('plomeria', 'asdfgh', 'qwerty zxcv');
  assert.ok(last(job).buttons.some(b => b.action === 'human'));
  const handed = await chat('plomeria', 'quiero hablar con una persona');
  assert.equal(handed.needsHuman, true);
});

test('mensaje corto pide detalles; día no disponible; detalle extra se anota', async () => {
  const job = await chat('plomeria', 'se me tapó el baño');
  assert.equal(job.itemId, 'destape');
  assert.equal(job.description, null);
  let j2 = await chat('plomeria', 'se me tapó el baño', 'el de arriba no baja desde ayer');
  const busy = ['domingo', 'lunes', 'martes', 'jueves', 'viernes']
    .find(d => !j2.slots.some(s => nlu.norm(s).startsWith(d)));
  await agent.handleClientMessage(j2.id, { text: `el ${busy}` });
  j2 = store.getJob(j2.id);
  assert.match(last(j2).text, new RegExp(`${busy} ya no hay espacio`));
  const j3 = await chat('plomeria', 'se me tapó el baño', 'el de arriba no baja desde ayer', 'ojo, el edificio no tiene elevador');
  assert.match(j3.description, /elevador/);
  assert.match(last(j3).text, /^Anotado/);
});

test('celulares inválidos con la razón correcta', async () => {
  const cases = [['0012345678', /no empiezan con 0 ni con 1/], ['5555555555', /no parece real/], ['55 12', /tiene 4 dígitos/]];
  for (const [phone, re] of cases) {
    const job = await chat('tamales', 'quiero 2 tamales verdes', phone);
    assert.equal(job.phone, null);
    assert.match(last(job).text, re);
  }
  const ok = await chat('tamales', 'quiero 2 tamales verdes', '+52 1 55 1234 5678');
  assert.equal(ok.phone, '5512345678');
});

test('dirección por partes y validada', async () => {
  let job = await chat('limpieza', 'limpiar mi departamento', { action: 'slot:0', text: 'x' }, 'Morelos 45');
  assert.ok(!job.address);
  assert.match(last(job).text, /colonia/i);
  await agent.handleClientMessage(job.id, { text: 'Narvarte' });
  job = store.getJob(job.id);
  assert.equal(job.address, 'Morelos 45, Col. Narvarte');
  const bad = await chat('limpieza', 'limpiar mi departamento', { action: 'slot:0', text: 'x' }, 'asdkj qwpo');
  assert.ok(!bad.address);
  assert.match(last(bad).text, /calle, número y colonia/i);
});

test('recuerda datos adelantados y acepta correcciones', async () => {
  let job = await chat('plomeria', 'hola, me llamo Laura. Se me tapó el baño de arriba desde ayer, vivo en Morelos 45 col. Centro, mi cel 55 8765 4321');
  assert.equal(job.name, 'Laura');
  assert.equal(job.itemId, 'destape');
  assert.equal(job.address, 'Morelos 45, Col. Centro');
  assert.equal(job.phone, '5587654321');
  assert.match(last(job).text, /Laura/);
  await agent.handleClientMessage(job.id, { action: 'slot:0', text: 'x' });
  job = store.getJob(job.id);
  assert.equal(last(job).kind, 'quote');
  await agent.handleClientMessage(job.id, { text: 'perdón, mejor cambia mi número a 55 1111 2222' });
  job = store.getJob(job.id);
  assert.equal(job.phone, '5511112222');
  assert.equal(last(job).kind, 'quote');
  assert.match(last(job).text, /Cambié tu celular/);
});

test('corrige el horario con la hora', async () => {
  let job = await chat('plomeria', 'se me tapó el baño de arriba desde ayer', { action: 'slot:1', text: 'x' }, 'Morelos 45, col. Centro', '55 8765 4321');
  assert.match(job.slot, /16:00/);
  await agent.handleClientMessage(job.id, { text: 'perdón, mejor cambia a las 9' });
  job = store.getJob(job.id);
  assert.match(job.slot, /9:00/);
  assert.equal(last(job).kind, 'quote');
});

test('pregunta si es un robot', async () => {
  const job = await chat('dental', '¿eres un robot?');
  assert.match(last(job).text, /asistente virtual/);
});

test('calificación al terminar de pagar', async () => {
  let job = await chat('tamales', 'quiero 3 de rajas', 'QR', 'sí');
  const payments = await import('../src/payments.js');
  payments.handlePaymentEvent({ type: 'codi.qr.payment_received', amount: 75, transactionId: 'T-' + job.id, metadata: { chargeId: store.getJob(job.id) && job.id } }, 'e-' + job.id);
  const charge = (await import('../src/store.js')).chargesForJob(job.id)[0];
  payments.handlePaymentEvent({ type: 'codi.qr.payment_received', amount: 75, transactionId: 'T2-' + job.id, metadata: { chargeId: charge.id } }, 'e2-' + job.id);
  job = store.getJob(job.id);
  assert.equal(last(job).kind, 'rate');
  await agent.handleClientMessage(job.id, { action: 'rate:5', text: '⭐⭐⭐⭐⭐' });
  await agent.handleClientMessage(job.id, { text: 'Riquísimos y muy rápido' });
  const r = store.ratingForJob(job.id);
  assert.equal(r.stars, 5);
  assert.equal(r.comment, 'Riquísimos y muy rápido');
});

test('pago con QR sin dar celular', async () => {
  const job = await chat('tamales', 'quiero 3 de rajas', 'QR', 'sí');
  assert.equal(job.phoneSkipped, true);
  assert.equal(last(job).kind, 'charge');
});
