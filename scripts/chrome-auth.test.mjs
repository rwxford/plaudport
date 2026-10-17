import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { captureCredentials, createSync, inspectRequest, describeNativeFailure } from '../chrome-extension/capture.mjs';
import { encodeMessage, readMessage, mergeCredentials, saveCredentials, validateCredentials } from './chrome-auth-lib.mjs';
import { install, extensionId, HOST_NAME } from './chrome-auth-install.mjs';

function fixture(exp = Math.floor(Date.now() / 1000) + 3600) {
  // Invented unsigned fixture, constructed so it cannot resemble a real secret.
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return { type: 'credentials', auth: 'Bearer ' + [encode({alg:'none'}), encode({exp}), 'fake'].join('.'),
    userToken: 'fixture-user-token', deviceId: 'fixture-device-id' };
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'plaudport-test-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  return dir;
}

test('captures only complete Plaud file requests initiated by the web app', () => {
  const c = fixture();
  const details = { initiator: 'https://web.plaud.ai', tabId: 1, url: 'https://api.plaud.ai/file/welcome',
    requestHeaders: [{name:'Authorization',value:c.auth},{name:'X-Pld-User',value:c.userToken},{name:'X-Device-Id',value:c.deviceId},
      {name:'Cookie',value:'do-not-copy'}, {name:'x-secret',value:'do-not-copy'}] };
  assert.deepEqual(captureCredentials(details), c);
  for (const patch of [{initiator:'https://evil.example'}, {initiator:undefined}, {tabId:-1}, {url:'https://api.plaud.ai.evil.example/file/welcome'},
    {url:'https://api.plaud.ai/auth/login'}, {url:'http://api.plaud.ai/file/welcome'}, {requestHeaders:details.requestHeaders.slice(0,2)}]) {
    assert.equal(captureCredentials({...details,...patch}), null);
  }
});

test('coalesces requests, retries failures and saves changed credentials', async () => {
  let sent = 0;
  let finish;
  const statuses = [];
  const sync = createSync(() => { sent++; return new Promise(resolve => {finish=resolve;}); }, ok => statuses.push(ok));
  const c = fixture();
  const first = sync(c);
  await sync(c); await sync(c);
  assert.equal(sent,1);
  finish({ok:true}); await first;
  assert.equal(sent,1);
  await sync(c);
  assert.equal(sent,1);
  const changed = {...c, deviceId:'new-device'};
  const second = sync(changed); finish({ok:false}); await second;
  const retry = sync(changed); finish({ok:true}); await retry;
  assert.deepEqual(statuses,[true,false,true]);
  assert.equal(sent,3);
});

test('bounds and validates credentials without leaking their values', () => {
  const c=fixture();
  assert.ok(validateCredentials(c).expiresAt > Date.now());
  for (const message of [{...c,auth:fixture(0).auth}, {...c,auth:fixture(Math.floor(Date.now()/1000)+30).auth},
    {...c,auth:'not-a-token'}, {...c,auth:'Bearer '+ 'x'.repeat(9000)}, {...c,userToken:'value\nINJECT=bad'},
    {...c,deviceId:'value # comment'}, {...c,userToken:'"quoted-value"'}, {...c,path:'/tmp/evil'}, null]) {
    assert.throws(() => validateCredentials(message), e => !e.message.includes(c.userToken));
  }
});

test('preserves unrelated env values and replaces every duplicate credential', () => {
  const before = '# Keep me\nFOO="a b"\n export PLAUD_AUTH = old\nPLAUD_AUTH=duplicate\n\n';
  const after = mergeCredentials(before, validateCredentials(fixture()).values);
  assert.match(after, /^# Keep me\nFOO="a b"\n/);
  assert.equal(after.split('\n').filter(l => l.startsWith('PLAUD_AUTH=')).length,2);
  assert.ok(!after.includes('old') && !after.includes('duplicate'));
});

test('writes atomically with mode 0600, rejects invalid input and leaves no temps', t => {
  const dir=temporary(t), env=join(dir,'.env');
  writeFileSync(env, 'KEEP=yes\n', {mode:0o644});
  const c=fixture();
  assert.equal(saveCredentials(env,c).ok,true);
  assert.equal(statSync(env).mode & 0o777,0o600);
  assert.ok(readFileSync(env,'utf8').startsWith('KEEP=yes\n'));
  assert.equal(saveCredentials(env,c).ok,true);
  const before=readFileSync(env,'utf8');
  assert.throws(()=>saveCredentials(env,{...c,deviceId:'evil\nBAD=yes'}));
  assert.equal(readFileSync(env,'utf8'),before);
  assert.equal(existsSync(env+'.chrome-lock'),false);
  writeFileSync(env+'.chrome-lock','');
  assert.throws(()=>saveCredentials(env,c), /busy/);
  assert.equal(readFileSync(env,'utf8'),before);
});

test('refuses symlink destinations, including dangling links', t => {
  const dir=temporary(t), env=join(dir,'.env'), target=join(dir,'target');
  writeFileSync(target,'untouched'); symlinkSync(target,env);
  assert.throws(()=>saveCredentials(env,fixture()));
  assert.equal(readFileSync(target,'utf8'),'untouched');
  rmSync(env); symlinkSync(join(dir,'missing'),env);
  assert.throws(()=>saveCredentials(env,fixture()));
  assert.equal(existsSync(join(dir,'missing')),false);
});

test('native framing accepts split bytes and rejects malformed/truncated/oversized input', async () => {
  const c=fixture(), frame=encodeMessage(c);
  const decoded=await readMessage(Readable.from([frame.subarray(0,1),frame.subarray(1,7),frame.subarray(7)]));
  assert.deepEqual(decoded,c);
  for (const bytes of [frame.subarray(0,10), Buffer.from([255,255,255,255]), Buffer.concat([frame,frame]), Buffer.from([2,0,0,0,33,33])]) {
    await assert.rejects(readMessage(Readable.from([bytes])));
  }
});

test('installer produces a working launcher for paths with spaces and quotes; uninstall keeps credentials', t => {
  const dir=temporary(t), root=join(dir,"checkout with ' quote"), home=join(dir,"home with ' quote");
  mkdirSync(join(root,'scripts'),{recursive:true}); mkdirSync(join(root,'chrome-extension'));
  // The real host and extension files are needed for the complete protocol test.
  for(const name of ['chrome-auth-host.mjs','chrome-auth-lib.mjs','chrome-auth-install.mjs']) {
    writeFileSync(join(root,'scripts',name),readFileSync(new URL(name,import.meta.url)));
  }
  writeFileSync(join(root,'chrome-extension/manifest.json'),readFileSync(new URL('../chrome-extension/manifest.json',import.meta.url)));
  install({root,home,platform:'darwin'});
  const manifestPath=join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts',HOST_NAME+'.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${extensionId()}/`]);
  const c=fixture();
  const run=spawnSync(manifest.path,[manifest.allowed_origins[0]],{input:encodeMessage(c)});
  assert.equal(run.status,0,run.stderr.toString());
  const reply=JSON.parse(run.stdout.subarray(4).toString());
  assert.equal(reply.ok,true);
  assert.ok(!run.stdout.toString().includes(c.userToken));
  assert.equal(run.stderr.length,0);
  const env=join(home,'Library/Application Support/PlaudPort/chrome-auth.env'), before=readFileSync(env,'utf8');
  assert.equal(existsSync(join(root,'.env')),false);
  const moved=root+'-moved';
  renameSync(root,moved);
  const independent=spawnSync(manifest.path,[manifest.allowed_origins[0]],{cwd:'/',env:{PATH:'/usr/bin:/bin'},input:encodeMessage(c)});
  assert.equal(independent.status,0);
  assert.equal(JSON.parse(independent.stdout.subarray(4)).ok,true);
  renameSync(moved,root);
  const badCaller=spawnSync(manifest.path,['chrome-extension://wrong/'],{input:encodeMessage(c)});
  assert.equal(JSON.parse(badCaller.stdout.subarray(4)).ok,false);
  assert.equal(readFileSync(env,'utf8'),before);
  const invalid=spawnSync(manifest.path,[manifest.allowed_origins[0]],{input:encodeMessage({...c,userToken:'secret\nBAD=value'})});
  assert.equal(JSON.parse(invalid.stdout.subarray(4)).ok,false);
  assert.ok(!invalid.stdout.toString().includes('secret'));
  install({root,home,platform:'darwin',uninstall:true});
  assert.equal(existsSync(manifestPath),false);
  assert.equal(readFileSync(env,'utf8'),before);
});


test('diagnostics expose presence only, never headers or request identifiers', () => {
  const c = fixture();
  const result = inspectRequest({url:'https://api.plaud.ai/file/welcome?private=value',initiator:'https://web.plaud.ai',tabId:1,
    requestHeaders:[{name:'Authorization',value:c.auth},{name:'Cookie',value:'private-cookie'}]});
  assert.deepEqual(result,{fromPlaud:true,fileApi:true,headers:{authorization:true,'x-pld-user':false,'x-device-id':false}});
  assert.equal(inspectRequest({url:'https://evil.example/file/welcome'}),null);
  assert.ok(!JSON.stringify(result).includes(c.auth));
});


test('native Chrome error classification never returns raw error text', () => {
  assert.match(describeNativeFailure(new Error('Native host has exited.')), /^HOST_EXITED:/);
  assert.match(describeNativeFailure(new Error('Error when communicating with the native messaging host.')), /^HOST_COMMUNICATION_FAILED:/);
  assert.match(describeNativeFailure(new Error('Failed to start native messaging host.')), /^HOST_START_FAILED:/);
  assert.match(describeNativeFailure(new Error('Specified native messaging host not found.')), /^HOST_NOT_FOUND:/);
  assert.match(describeNativeFailure(new Error('Access to the specified native messaging host is forbidden.')), /^HOST_FORBIDDEN:/);
  assert.match(describeNativeFailure(new Error('private-secret')), /^HOST_UNKNOWN_ERROR:/);
  assert.ok(!describeNativeFailure(new Error('private-secret')).includes('private-secret'));
});
