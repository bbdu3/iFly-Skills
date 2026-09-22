import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const nodes = [
  require('../dist/nodes/IflyTranslate/IflyTranslate.node.js').IflyTranslate,
  require('../dist/nodes/IflyTextProofread/IflyTextProofread.node.js').IflyTextProofread,
  require('../dist/nodes/IflyOcrInvoice/IflyOcrInvoice.node.js').IflyOcrInvoice,
  require('../dist/nodes/IflyHyperTts/IflyHyperTts.node.js').IflyHyperTts,
];

test('four MVP node classes expose stable n8n metadata', () => {
  const instances = nodes.map((Node) => new Node());
  assert.deepEqual(instances.map(({ description }) => description.name), [
    'iflyTranslate', 'iflyTextProofread', 'iflyOcrInvoice', 'iflyHyperTts',
  ]);
  for (const { description } of instances) {
    assert.deepEqual(description.inputs, ['main']);
    assert.deepEqual(description.outputs, ['main']);
    assert.equal(description.version, 1);
  }
  assert.equal(instances[0].description.credentials[0].name, 'iflyApi');
  assert.equal(instances[1].description.credentials[0].name, 'iflyApi');
  assert.equal(instances[2].description.credentials[0].name, 'iflyApi');
  assert.equal(instances[3].description.credentials[0].name, 'iflyApi');
  assert.equal(instances[3].description.credentials[0].required, false);
  assert.deepEqual(instances[3].description.properties.find(({ name }) => name === 'operation').options.map(({ value }) => value), [
    'synthesize', 'listVoices',
  ]);
});
