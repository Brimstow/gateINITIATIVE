// gateinitiative: Safe Evaluation Worker
//
// Runs gate regex evaluation off the main thread so a catastrophically
// backtracking pattern (ReDoS) can be terminated by the parent instead of
// stalling the daemon. The parent attributes a timeout to the gate whose
// 'gate-start' message was not followed by a 'gate-result'.

import { parentPort } from 'node:worker_threads';
import { evaluateGate } from './evaluator.mjs';

parentPort.on('message', ({ id, gates, content, relPath }) => {
  for (const gate of gates) {
    parentPort.postMessage({ id, type: 'gate-start', gateId: gate.id });
    const violation = evaluateGate(gate, content, relPath);
    parentPort.postMessage({ id, type: 'gate-result', gateId: gate.id, violation });
  }
  parentPort.postMessage({ id, type: 'done' });
});
