// stdout is reserved for Chrome's framed protocol. Never print credentials/errors.
import { readMessage, encodeMessage, saveCredentials } from './chrome-auth-lib.mjs';
import { extensionId } from './chrome-auth-install.mjs';
import { resolve } from 'node:path';

const timer = setTimeout(() => process.exit(1), 5000);
try {
  const [, , option, envPath, origin] = process.argv;
  if (option !== '--env-path' || !envPath || resolve(envPath) !== envPath || origin !== `chrome-extension://${extensionId()}/`) {
    throw new Error('Invalid native caller.');
  }
  const message = await readMessage(process.stdin);
  const result = saveCredentials(envPath, message);
  process.stdout.write(encodeMessage(result));
} catch {
  // A constant error prevents credentials, filesystem paths or parse input from
  // leaking into Chrome's logs, the badge, or a native response.
  process.stdout.write(encodeMessage({ ok: false, error: 'Credential sync failed. See docs/CHROME-AUTH.md.' }));
} finally { clearTimeout(timer); }
