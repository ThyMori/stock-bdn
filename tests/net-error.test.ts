import assert from 'node:assert/strict';
import { friendlyError, isNetworkMessage } from '../src/netError';

for (const m of ['TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'TypeError: network error']) assert.ok(isNetworkMessage(m), m);
assert.ok(!isNetworkMessage('Droits insuffisants'));
assert.equal(friendlyError('Droits insuffisants'), 'Droits insuffisants');                    // une erreur serveur reste telle quelle
assert.ok(friendlyError('TypeError: Failed to fetch').includes('À jour'));                  // synchro : on propose de réessayer
assert.ok(friendlyError('TypeError: Failed to fetch', true).includes("n'a pas été envoyée"));   // action : on dit qu'elle n'est pas partie
assert.ok(!/fetch/i.test(friendlyError('TypeError: Failed to fetch')));
console.log('net-error OK');
