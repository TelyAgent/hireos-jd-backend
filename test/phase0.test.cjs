const { test } = require('node:test');
const assert = require('node:assert/strict');

test('JD backend package is present for the Core/JD boundary', () => {
  assert.equal(typeof require('../dist/app.module').AppModule, 'function');
});
