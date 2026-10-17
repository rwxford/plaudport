import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_NAME = 'com.plaudport.chrome_auth';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function extensionId() {
  const { key } = JSON.parse(readFileSync(join(repo, 'chrome-extension/manifest.json'), 'utf8'));
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
export function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export function install({ root = repo, home = homedir(), node = process.execPath, platform = process.platform, uninstall = false } = {}) {
  if (platform !== 'darwin') throw new Error('Chrome credential sync currently supports macOS only.');
  root = realpathSync(root);
  const hostDir = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
  const manifestPath = join(hostDir, `${HOST_NAME}.json`);
  const supportDir = join(home, 'Library/Application Support/PlaudPort');
  const localDir = join(supportDir, 'chrome-native-host');
  const credentialPath = join(supportDir, 'chrome-auth.env');
  if (uninstall) {
    // Only remove the registration when this checkout installed it.
    let owner;
    try { owner = JSON.parse(readFileSync(join(localDir, 'installation.json'), 'utf8')).root; } catch {}
    if (owner !== root) return;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}
    if (manifest?.path === join(localDir, 'launch.sh')) rmSync(manifestPath);
    rmSync(localDir, { recursive: true, force: true });
    return;
  }
  mkdirSync(hostDir, { recursive: true });
  mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  chmodSync(supportDir, 0o700);
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  chmodSync(localDir, 0o700);
  // Chrome must not execute or write inside Documents/Desktop/Downloads.
  // Install a self-contained runtime under Application Support instead.
  mkdirSync(join(localDir, 'scripts'), { recursive: true, mode: 0o700 });
  mkdirSync(join(localDir, 'chrome-extension'), { recursive: true, mode: 0o700 });
  for (const name of ['chrome-auth-host.mjs', 'chrome-auth-lib.mjs', 'chrome-auth-install.mjs']) {
    const destination = join(localDir, 'scripts', name);
    writeFileSync(destination, readFileSync(join(root, 'scripts', name)), { mode: 0o600 });
    chmodSync(destination, 0o600);
  }
  writeFileSync(join(localDir, 'chrome-extension/manifest.json'), readFileSync(join(root, 'chrome-extension/manifest.json')), { mode: 0o600 });
  writeFileSync(join(localDir, 'installation.json'), JSON.stringify({ root }), { mode: 0o600 });
  const launcher = join(localDir, 'launch.sh');
  const script = '#!/bin/sh\nexec ' + shellQuote(node) + ' ' + shellQuote(join(localDir, 'scripts/chrome-auth-host.mjs'))
    + ' --env-path ' + shellQuote(credentialPath) + ' "$@"\n';
  writeFileSync(launcher, script, { mode: 0o700 });
  chmodSync(launcher, 0o700);
  writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME, description: 'Save Plaud credentials locally in Application Support', path: launcher,
    type: 'stdio', allowed_origins: [`chrome-extension://${extensionId()}/`] }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--uninstall')) throw new Error('Usage: npm run chrome:install [-- --uninstall]');
    install({ uninstall: args.includes('--uninstall') });
    console.log(args.includes('--uninstall') ? 'Chrome helper uninstalled. Saved credentials and your .env were kept.'
      : 'Chrome helper installed in Application Support.\nIn chrome://extensions, enable Developer mode, then Load unpacked:\n' + join(repo, 'chrome-extension')
      + '\nThen open your Personal workspace at https://web.plaud.ai/ and reload it.\nLook for the green OK badge, then run npm run check:auth.');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
