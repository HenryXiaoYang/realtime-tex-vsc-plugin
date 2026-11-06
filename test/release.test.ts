import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetName, assetUrl, isNewer, latestWithAsset, parseVersion, releaseTarget, sha256For } from '../src/release';

test('each supported machine maps to its release archive', () => {
  assert.equal(assetName(releaseTarget('linux', 'x64')!), 'rtex-x86_64-unknown-linux-gnu.tar.gz');
  assert.equal(assetName(releaseTarget('linux', 'arm64')!), 'rtex-aarch64-unknown-linux-gnu.tar.gz');
  assert.equal(assetName(releaseTarget('darwin', 'arm64')!), 'rtex-aarch64-apple-darwin.tar.gz');
  assert.equal(assetName(releaseTarget('darwin', 'x64')!), 'rtex-x86_64-apple-darwin.tar.gz');
  assert.equal(assetName(releaseTarget('win32', 'x64')!), 'rtex-x86_64-pc-windows-msvc.zip');
  assert.equal(releaseTarget('win32', 'arm64'), undefined);
  assert.equal(releaseTarget('freebsd', 'x64'), undefined);
  assert.equal(
    assetUrl('v0.0.2', releaseTarget('linux', 'x64')!),
    'https://github.com/HenryXiaoYang/realtime-tex/releases/download/v0.0.2/rtex-x86_64-unknown-linux-gnu.tar.gz',
  );
});

test('versions compare numerically', () => {
  assert.deepEqual(parseVersion('v0.0.2'), [0, 0, 2]);
  assert.deepEqual(parseVersion('0.10.1-rc1'), [0, 10, 1]);
  assert.equal(parseVersion('nightly'), undefined);
  assert.equal(isNewer('v0.0.3', 'v0.0.2'), true);
  assert.equal(isNewer('v0.0.10', 'v0.0.9'), true);
  assert.equal(isNewer('v0.1', 'v0.0.9'), true);
  assert.equal(isNewer('v0.0.2', 'v0.0.2'), false);
  assert.equal(isNewer('v0.0.1', 'v0.0.2'), false);
  assert.equal(isNewer('v0.0.2', undefined), true);
  assert.equal(isNewer('nightly', 'v0.0.2'), false);
});

test('checksums are read from .sha256 files and SHA256SUMS', () => {
  const h = 'ab'.repeat(32);
  const other = 'cd'.repeat(32);
  assert.equal(sha256For(`${h}  rtex-x86_64-unknown-linux-gnu.tar.gz\n`, 'rtex-x86_64-unknown-linux-gnu.tar.gz'), h);
  // Windows assets are listed in binary mode (`*name`)
  assert.equal(sha256For(`${h.toUpperCase()} *rtex-x86_64-pc-windows-msvc.zip\r\n`, 'rtex-x86_64-pc-windows-msvc.zip'), h);
  assert.equal(sha256For(`${other}  a.tar.gz\n${h}  b.tar.gz\n`, 'b.tar.gz'), h);
  assert.equal(sha256For(`${other}  a.tar.gz\n`, 'b.tar.gz'), undefined);
  assert.equal(sha256For(`${h}\n`, 'anything'), h);
  assert.equal(sha256For('not a checksum', 'a'), undefined);
});

test('the latest release is the newest one with this machine\'s archive and checksum', () => {
  const name = 'rtex-x86_64-pc-windows-msvc.zip';
  const rel = (tag: string, assets: string[], extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: assets.map((n) => ({ name: n })), ...extra });
  const releases = [
    rel('v0.0.9', [name, `${name}.sha256`], { draft: true }),
    rel('v0.0.8', [name, `${name}.sha256`], { prerelease: true }),
    rel('v0.0.7', ['rtex-x86_64-unknown-linux-gnu.tar.gz', 'rtex-x86_64-unknown-linux-gnu.tar.gz.sha256']), // still uploading
    rel('v0.0.6', [name]), // no checksum
    rel('v0.0.5', [name, `${name}.sha256`]),
  ];
  assert.equal(latestWithAsset(releases, name), 'v0.0.5');
  assert.equal(latestWithAsset(releases, 'rtex-x86_64-unknown-linux-gnu.tar.gz'), 'v0.0.7');
  assert.equal(latestWithAsset(releases, undefined), 'v0.0.7');
  assert.equal(latestWithAsset({ message: 'API rate limit exceeded' }, name), undefined);
  assert.equal(latestWithAsset([], name), undefined);
});
