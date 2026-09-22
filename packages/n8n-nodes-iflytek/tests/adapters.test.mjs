import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PythonRunner } = require('../dist/shared/PythonRunner.js');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonExecutable = process.env.IFLY_TEST_PYTHON
  || spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const credentials = { appId: 'app', apiKey: 'key', apiSecret: 'secret' };

const fakeScripts = {
  'iflytek-translate/scripts/translate.py': `URL = 'https://example.invalid'
def _normalize_lang(value): return value
def _build_body(app, text, source, target): return text
def _build_headers(key, secret, body): return {}
def _http_post(url, body, headers): return {'ok': True}
def _parse_result(response): return ({'src': 'hello', 'dst': '你好', 'from': 'en', 'to': 'cn'}, None)
`,
  'iflytek-text-proofread/scripts/text_proofread.py': `API_URL = 'https://example.invalid'
def _build_auth_url(url, key, secret): return url
def _build_body(app, text): return {'text': text}
def _http_post(url, body, app): return {'ok': True}
def _parse_result(response): return {'code': 200, 'data': {'checklist': []}}
`,
  'iflytek-ocr-invoice/scripts/invoice.py': `def recognize_invoice(path, app, key, secret):
    assert path.endswith('.pdf')
    return {'invoice': 'raw'}
def extract_result(data): return '{"total": 12}'
`,
  'iflytek-hyper-tts/scripts/xfei_hyper_tts.py': `DEFAULT_VOICE = 'voice'
FREE_VOICES = [{'vcn': 'voice'}]
VOICE_LIST = [{'vcn': 'voice'}]
class XfeiHyperTTSClient:
    def __init__(self, app_id, api_key, api_secret): pass
    def synthesize(self, text, output_path, **kwargs):
        with open(output_path, 'wb') as stream: stream.write(b'fake-mp3')
        return {'success': True, 'text_length': len(text)}
`,
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ifly-adapter-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const temporaryRoot = path.join(root, 'invocations');
  await mkdir(path.join(runtimeRoot, 'bridge'), { recursive: true });
  await mkdir(temporaryRoot);
  await cp(path.join(packageRoot, 'runtime/bridge/bridge.py'), path.join(runtimeRoot, 'bridge/bridge.py'));
  await cp(path.join(packageRoot, 'runtime/bridge/operations.json'), path.join(runtimeRoot, 'bridge/operations.json'));
  for (const [relative, source] of Object.entries(fakeScripts)) {
    const target = path.join(runtimeRoot, 'skills', relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return { runner: new PythonRunner({ pythonExecutable, runtimeRoot, temporaryRoot, timeoutMs: 5000 }), temporaryRoot };
}

const consume = async (result, files) => ({ result, files });

test('packaged bridge adapters map text, binary, invoice, TTS, and local voices', async (t) => {
  const { runner, temporaryRoot } = await fixture(t);
  const translation = await runner.run({
    skill: 'iflytek-translate', operation: 'translate', input: { text: 'hello' },
    parameters: { fromLanguage: 'en', toLanguage: 'cn' }, credentials,
  }, consume);
  assert.equal(translation.result.data.translatedText, '你好');

  const proofread = await runner.run({
    skill: 'iflytek-text-proofread', operation: 'check', files: { text: { data: Buffer.from('文本') } },
    credentials,
  }, consume);
  assert.equal(proofread.result.data.result.code, 200);

  const invoice = await runner.run({
    skill: 'iflytek-ocr-invoice', operation: 'recognize', files: { image: { data: Buffer.from('%PDF-1.7') } },
    credentials,
  }, consume);
  assert.equal(invoice.result.data.result.total, 12);

  const tts = await runner.run({
    skill: 'iflytek-hyper-tts', operation: 'synthesize', input: { text: 'hello' }, credentials,
  }, consume);
  assert.equal(tts.files[0].mimeType, 'audio/mpeg');
  assert.equal(tts.files[0].data.toString(), 'fake-mp3');

  const voices = await runner.run({ skill: 'iflytek-hyper-tts', operation: 'listVoices' }, consume);
  assert.equal(voices.result.data.defaultVoice, 'voice');
  assert.deepEqual(await readdir(temporaryRoot), []);
});
