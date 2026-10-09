import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releaseNotes, releaseTag, validateFileList, verifyReadmes, verifyRuntime } from '../scripts/prepare-release.mjs';
import { inspectRegistryReadme, keywordSearch, validatePublished } from '../scripts/verify-registry.mjs';

test('release channels reject ambiguous versions', () => {
  assert.equal(releaseTag('0.1.0'), 'latest');
  assert.equal(releaseTag('0.2.0-beta.1'), 'beta');
  for (const version of ['0.1', 'v0.1.0', '0.1.0-dev.0', '01.1.0', '0.1.0-beta.01', 'latest', '../package']) assert.throws(() => releaseTag(version));
});

test('release notes include only the requested stable or beta version', () => {
  const changelog = '# Changelog\n\n## Unreleased\n\n- Pending.\n\n## 0.2.0\n\n### Added\n\n- Current.\n\n## 0.2.0-beta.1\n\n- Preview.\n\n## 0.1.0\n\n- Previous.\n';
  const expected = '## 0.2.0\n\n### Added\n\n- Current.\n';
  assert.equal(releaseNotes(changelog, '0.2.0'), expected);
  assert.equal(releaseNotes(changelog.replace(/\n/g, '\r\n'), '0.2.0'), expected);
  assert.equal(releaseNotes(changelog, '0.2.0-beta.1'), '## 0.2.0-beta.1\n\n- Preview.\n');
  assert.equal(releaseNotes(changelog, '0.1.0'), '## 0.1.0\n\n- Previous.\n');
  assert.throws(() => releaseNotes(changelog, '0.3.0'), /exactly one changelog section/);
  assert.throws(() => releaseNotes(changelog + '\n## 0.2.0\n\n- Duplicate.\n', '0.2.0'), /exactly one changelog section/);
  assert.throws(() => releaseNotes('## 0.2.0\n\n## 0.1.0\n\n- Previous.\n', '0.2.0'), /Empty changelog section/);
});

test('packed releases require registered code, runtime files, user docs and templates', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../runtime/manifest.json', import.meta.url)));
  const names = ['package.json', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE',
    ...pkg.n8n.nodes, ...pkg.n8n.credentials, 'runtime/manifest.json',
    ...Object.keys(manifest.files).map(name => 'runtime/' + name),
    ...['proofread-and-translate', 'invoice-recognition', 'text-to-speech'].map(name => `workflows/${name}.json`)];
  const files = names.map(path => ({ path }));
  validateFileList(files, pkg, manifest);
  assert.throws(() => validateFileList(files.filter(file => file.path !== pkg.n8n.nodes[0]), pkg, manifest), /Missing packed file/);
  for (const name of ['README.md', 'README.zh-CN.md']) {
    assert.throws(() => validateFileList(files.filter(file => file.path !== name), pkg, manifest), /Missing packed file/);
  }
  for (const name of ['runtime/../outside', 'runtime/.env', 'runtime/__pycache__/file.pyc', 'tests/fixture.json', 'node_modules/secret']) {
    assert.throws(() => validateFileList([...files, { path: name }], pkg, manifest));
  }
});

test('packed READMEs preserve the default and translated source content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ifly-readme-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const packed = path.join(root, 'packed');
  await mkdir(source);
  await mkdir(packed);
  const contents = { 'README.md': '# English installation guide\r\n', 'README.zh-CN.md': '# 中文概述\r\n' };
  for (const [name, content] of Object.entries(contents)) {
    await writeFile(path.join(source, name), content);
    await writeFile(path.join(packed, name), content);
  }
  await verifyReadmes(source, packed);
  for (const [name, content] of Object.entries(contents)) {
    await writeFile(path.join(packed, name), '# Replaced README\n');
    await assert.rejects(verifyReadmes(source, packed), /Packed README differs from source/);
    await rm(path.join(packed, name));
    await assert.rejects(verifyReadmes(source, packed), { code: 'ENOENT' });
    await writeFile(path.join(packed, name), content);
  }
  await writeFile(path.join(source, 'README.md'), ' \n');
  await writeFile(path.join(packed, 'README.md'), ' \n');
  await assert.rejects(verifyReadmes(source, packed), /Empty source README/);
});

test('keyword search fits registry limits and matches only the full package name', async () => {
  const name = '@iflytekopensource/n8n-nodes-iflytek-skills';
  const similar = ['n8n-nodes-iflytek-skills', '@another/n8n-nodes-iflytek-skills', name + '-extra'];
  const fakeFetch = names => async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(url.pathname, '/-/v1/search');
    const query = url.searchParams.get('text');
    assert.ok(query.length >= 2 && query.length <= 64, 'npm search accepts 2–64 characters');
    assert.ok(query.includes('keywords:n8n-community-node-package'));
    assert.ok(query.includes('iflytek'));
    assert.equal(url.searchParams.get('size'), '250');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ objects: names.map(name => ({ package: { name } })) });
  };
  assert.equal((await keywordSearch(name, fakeFetch(similar))).indexed, false);
  assert.equal((await keywordSearch(name, fakeFetch([]))).indexed, false);
  assert.equal((await keywordSearch(name, fakeFetch([...similar, name]))).indexed, true);
});

test('keyword search errors do not become pending indexing results', async () => {
  const name = '@iflytekopensource/n8n-nodes-iflytek-skills';
  for (const status of [400, 429, 503]) {
    await assert.rejects(keywordSearch(name, async () => new Response('', { status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(keywordSearch(name, async () => { throw new Error('connection lost'); }), /connection lost/);
  await assert.rejects(keywordSearch(name, async () => new Response('not JSON')), SyntaxError);
  await assert.rejects(keywordSearch(name, async () => Response.json({})), /Invalid registry search response/);
});

test('registry README metadata is compared separately with the packed default', () => {
  const readme = '# English installation guide\r\n';
  const matching = inspectRegistryReadme({ readme: readme.replace(/\r\n/g, '\n'), readmeFilename: 'README.md' }, readme);
  assert.equal(matching.filename, 'README.md');
  assert.equal(matching.contentMatchesPackedDefault, true);
  const translated = inspectRegistryReadme({ readme: '# 中文概述\n', readmeFilename: 'README.zh-CN.md' }, readme);
  assert.equal(translated.filename, 'README.zh-CN.md');
  assert.equal(translated.contentMatchesPackedDefault, false);
  assert.match(translated.note, /not version-specific/);
  assert.equal(inspectRegistryReadme({}, readme).contentMatchesPackedDefault, false);
  assert.equal(inspectRegistryReadme({}, readme).filename, null);
});

test('release preparation verifies the scoped archive in an absolute path with spaces', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'ifly scoped release test-'));
  t.after(() => rm(output, { recursive: true, force: true, maxRetries: 3 }));
  assert.ok(process.env.npm_execpath, 'Run release tests through npm test');
  execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'release:prepare', '--', '--output', output, '--allow-dirty'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const report = JSON.parse(await readFile(path.join(output, 'release.json')));
  assert.equal(report.package, '@iflytekopensource/n8n-nodes-iflytek-skills');
  assert.equal(report.filename, `iflytekopensource-n8n-nodes-iflytek-skills-${pkg.version}.tgz`);
  assert.equal(report.publishable, !report.sourceTreeDirty);
  const bytes = await readFile(path.join(output, report.filename));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.sha256);
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(await readFile(path.join(output, 'CHANGELOG.md'), 'utf8'), changelog);
  assert.equal(await readFile(path.join(output, 'RELEASE_NOTES.md'), 'utf8'), releaseNotes(changelog, pkg.version));
});

test('artifact checks detect changed runtime bytes and published tarballs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ifly-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtime'));
  const bytes = Buffer.from('same-size-source');
  const manifest = { files: { 'bridge.py': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } };
  await writeFile(path.join(root, 'runtime/bridge.py'), bytes);
  await verifyRuntime(root, manifest);
  await writeFile(path.join(root, 'runtime/bridge.py'), Buffer.from('changed--source!'));
  await assert.rejects(verifyRuntime(root, manifest), /Runtime hash mismatch/);
  const release = { package: '@iflytekopensource/n8n-nodes-iflytek-skills', version: '0.1.0', n8n: {}, keywords: ['n8n-community-node-package'],
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), sha256: manifest.files['bridge.py'].sha256 };
  const metadata = { name: release.package, version: release.version, n8n: {}, keywords: release.keywords, dist: { integrity: release.integrity } };
  validatePublished(metadata, release, bytes);
  assert.throws(() => validatePublished(metadata, release, Buffer.from('changed artifact')));
  assert.throws(() => validatePublished({ ...metadata, n8n: { nodes: [] } }, release, bytes));
  assert.throws(() => validatePublished({ ...metadata, keywords: [] }, release, bytes));
  assert.throws(() => validatePublished({ ...metadata, version: '0.0.0-stage' }, release, bytes));
  assert.throws(() => validatePublished({ ...metadata, dist: { integrity: 'sha512-incorrect' } }, release, bytes));
});

test('workflow exports are inactive, unbound and connect only valid nodes', async () => {
  const directory = new URL('../workflows/', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const catalog = JSON.parse(await readFile(new URL('../skills.json', import.meta.url)));
  const registered = new Set(catalog.skills.map(skill => `${pkg.name}.${skill.nodeName}`));
  const files = await readdir(directory);
  assert.equal(files.length, 3);
  for (const filename of files) {
    const workflow = JSON.parse(await readFile(new URL(filename, directory)));
    assert.equal(workflow.active, false);
    assert.equal(workflow.pinData, undefined);
    const names = new Set(workflow.nodes.map(node => node.name));
    assert.equal(names.size, workflow.nodes.length);
    assert.equal(workflow.nodes.filter(node => node.type === 'n8n-nodes-base.manualTrigger').length, 1);
    for (const node of workflow.nodes) {
      assert.ok(node.type.startsWith('n8n-nodes-base.') || registered.has(node.type), `Unregistered node type: ${node.type}`);
      assert.equal(node.credentials, undefined);
      assert.ok(!node.retryOnFail);
      assert.ok(!/webhook|scheduleTrigger|httpRequest|code$/.test(node.type));
    }
    for (const [source, connection] of Object.entries(workflow.connections)) {
      assert.ok(names.has(source));
      for (const output of connection.main.flat()) assert.ok(names.has(output.node));
    }
  }
});
