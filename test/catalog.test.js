import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote, businesses, findItem, getBusiness, itemById, scheduleLabel } from '../src/catalog.js';

const plomeria = getBusiness('plomeria');
const postres = getBusiness('postres');
const tamales = getBusiness('tamales');

test('carga los negocios de ejemplo con Clarito como agente por defecto', () => {
  assert.ok(businesses.length >= 3);
  for (const b of businesses) assert.equal(b.agentName, 'Clarito');
});

test('identifica el producto o servicio desde texto libre, por negocio', () => {
  assert.equal(findItem(plomeria, 'se me tapó el baño')?.id, 'destape');
  assert.equal(findItem(plomeria, 'tengo una fuga en la cocina')?.id, 'fuga');
  assert.equal(findItem(plomeria, 'el boiler no calienta')?.id, 'calentador');
  assert.equal(findItem(plomeria, 'hola'), null);
  assert.equal(findItem(postres, 'un pastel para cumpleaños')?.id, 'pastel');
  assert.equal(findItem(tamales, 'quiero 10 tamales verdes')?.id, 'verde');
});

test('servicio con cita: anticipo del 50%', () => {
  const q = buildQuote(plomeria, itemById(plomeria, 'fuga'));
  assert.equal(q.total, 450);
  assert.equal(q.deposit, 225);
  assert.equal(scheduleLabel(plomeria), 'Cita');
});

test('pedido y venta directa: cantidad y pago completo', () => {
  const q = buildQuote(tamales, itemById(tamales, 'verde'), 10);
  assert.equal(q.total, 250);
  assert.equal(q.deposit, 250);
  assert.equal(q.items[0].quantity, 10);
  assert.equal(scheduleLabel(tamales), null);
  assert.equal(scheduleLabel(postres), 'Entrega');
});
