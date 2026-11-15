import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuote, findService, serviceById } from '../src/catalog.js';

test('identifica el servicio desde texto libre', () => {
  assert.equal(findService('se me tapó el baño')?.id, 'destape');
  assert.equal(findService('tengo una fuga en la cocina')?.id, 'fuga');
  assert.equal(findService('el boiler no calienta')?.id, 'calentador');
  assert.equal(findService('hola'), null);
});

test('la cotización usa el precio del catálogo y anticipo del 50%', () => {
  const q = buildQuote(serviceById('fuga'));
  assert.equal(q.total, 450);
  assert.equal(q.deposit, 225);
});
