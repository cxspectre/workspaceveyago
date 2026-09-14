/* The page's script order, which several fixes depend on and nothing else
   would notice breaking. Classic scripts share one global scope and run in
   document order, so:

   - data/writes.js binds its capture-phase listeners before app.js and
     workspace.js bind theirs. Capture listeners on one node fire in the order
     they were added, so moving writes.js below them sends status changes,
     ticks and notes back to the offline handlers ("Updated in this demo
     session") — and every other test would still pass.
   - the models load before the views that call them at load time.
   - store.js loads last: it splices live rows into the arrays app.js declares.

   Run from the repo root with: node --test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const order = [...html.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
const at = name => {
  const index = order.indexOf(name);
  assert.ok(index >= 0, `${name} is on the page`);
  return index;
};

test('writes.js binds before the offline handlers in app.js and workspace.js', () => {
  assert.ok(at('data/writes.js') < at('app.js'));
  assert.ok(at('data/writes.js') < at('workspace.js'));
});

test('the models load before the views that use them', () => {
  assert.ok(at('mail-model.js') < at('mail-compose.js'));
  assert.ok(at('mail-compose.js') < at('mail.js'), 'mail.js renders with the composer as soon as it runs');
  assert.ok(at('projects-model.js') < at('workspace.js'));
  assert.ok(at('projects-model.js') < at('projects-ui.js'));
  assert.ok(at('workspace.js') < at('projects-ui.js'), 'the project page is drawn by workspace.js, its actions added by projects-ui.js');
  assert.ok(at('data/mail-html.js') < at('mail-compose.js'));
});

test('store.js loads last, after every array it fills', () => {
  assert.equal(order[order.length - 1], 'data/store.js');
});

test('every script carries the same cache-busting version', () => {
  const versions = new Set([...html.matchAll(/\.(?:js|css)\?v=(\d+)/g)].map(m => m[1]));
  assert.equal(versions.size, 1, `one version for all assets, found ${[...versions].join(', ')}`);
});
