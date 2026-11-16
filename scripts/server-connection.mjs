import { Client } from 'ssh2';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export async function connectServer(path = 'server.json') {
  const config = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  const knownPath = resolve('runs/deployment/known-host.json');
  let known;
  try { known = JSON.parse(await readFile(knownPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let fingerprint;
  const privateKey = config.privateKeyPath ? await readFile(config.privateKeyPath) : config.privateKey;
  const client = new Client();
  await new Promise((accept, reject) => {
    client.once('ready', accept).once('error', reject).connect({
      host: config.host, port: config.port || 22, username: config.username,
      password: config.password, privateKey,
      readyTimeout: 20000, keepaliveInterval: 15000,
      hostVerifier(key) {
        fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        return !known || (known.host === config.host && known.port === (config.port || 22) && known.fingerprint === fingerprint);
      },
    });
  });
  if (!known) {
    await mkdir(dirname(knownPath), { recursive: true });
    await writeFile(knownPath, JSON.stringify({ host: config.host, port: config.port || 22, fingerprint }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return { client, config, fingerprint };
}

export function remoteExec(client, command, timeout = 30000) {
  return new Promise((accept, reject) => {
    client.exec(command, (error, channel) => {
      if (error) { reject(error); return; }
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { channel.close(); reject(new Error('Remote command timed out')); }, timeout);
      channel.on('data', chunk => { stdout += chunk.toString(); });
      channel.stderr.on('data', chunk => { stderr += chunk.toString(); });
      channel.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }); });
    });
  });
}
