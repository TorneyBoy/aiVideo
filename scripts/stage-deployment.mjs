import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectServer, remoteExec } from './server-connection.mjs';

const manifest = JSON.parse(await readFile('runs/deployment/manifest.json', 'utf8'));
if (!/^[a-f0-9]{64}$/.test(manifest.sha256) || manifest.remoteRoot !== '/opt/aivideo-replica') throw new Error('Invalid deployment manifest');
const { client, config } = await connectServer();
const root = manifest.remoteRoot, release = `${root}/releases/${manifest.sha256.slice(0, 16)}`;
const protectedPath = config.remoteProjectDirectory?.replace(/\/$/, '');
if (protectedPath && (root === protectedPath || root.startsWith(protectedPath + '/') || protectedPath.startsWith(root + '/'))) { client.end(); throw new Error('Deployment directory overlaps the existing project'); }
const execute = async command => {
  const result = await remoteExec(client, command, 60000);
  if (result.code !== 0) throw new Error(result.stderr || 'Deployment preparation failed');
  return result.stdout;
};
try {
  const before = await execute("docker ps --format '{{.Names}} {{.ID}}'");
  await execute(`set -eu
if [ -e '${root}' ]; then
  test ! -L '${root}'
  test "$(cat '${root}/.aivideo-deployment-owner' 2>/dev/null)" = 'aivideo-replica-v1'
else
  install -d -m 750 '${root}'
  printf '%s\\n' aivideo-replica-v1 > '${root}/.aivideo-deployment-owner'
fi
install -d -m 750 '${root}/releases' '${root}/data' '${release}'
test ! -L '${root}/releases'
test ! -L '${root}/data'
test ! -L '${release}'
chown 1000:1000 '${root}/data'`);
  const sftp = await new Promise((accept, reject) => client.sftp((error, value) => error ? reject(error) : accept(value)));
  const put = (local, remote) => new Promise((accept, reject) => sftp.fastPut(resolve(local), remote, { mode: 0o600 }, error => error ? reject(error) : accept()));
  await put('runs/deployment/aivideo-release.tar.gz', `${release}/source.tar.gz`);
  await put('runs/deployment/.env.server', `${root}/.env.server.staging`);
  const checks = await execute(`set -eu
test "$(sha256sum '${release}/source.tar.gz' | cut -d ' ' -f 1)" = '${manifest.sha256}'
tar -xzf '${release}/source.tar.gz' -C '${release}' --no-same-owner
chmod 600 '${root}/.env.server.staging'
mv '${root}/.env.server.staging' '${root}/.env.server'
if [ ! -e '${release}/.env.server' ]; then ln -s '${root}/.env.server' '${release}/.env.server'; fi
if [ ! -e '${release}/data' ]; then ln -s '${root}/data' '${release}/data'; fi
docker compose -p aivideo-replica -f '${release}/deploy/compose.yaml' config --quiet
if [ -n "$(ss -ltn '( sport = :14173 )' | tail -n +2)" ]; then
  own_container=$(docker ps -q --filter label=com.docker.compose.project=aivideo-replica --filter label=com.docker.compose.service=app)
  test -n "$own_container"
  docker port "$own_container" 4173/tcp | grep -Fx '127.0.0.1:14173' >/dev/null
fi
printf '%s\\n' 'Compose configuration valid; dedicated port available or owned by aiVideo; existing applications untouched.'`);
  const after = await execute("docker ps --format '{{.Names}} {{.ID}}'");
  if (before.trim() !== after.trim()) throw new Error('Existing container set changed during preparation; inspect before activating');
  console.log(JSON.stringify({ staged: true, activated: false, remoteRoot: root, release, publicUrl: manifest.publicUrl,
    existingContainersUnchanged: true, nginxModified: false, checks: checks.trim() }, null, 2));
} finally { client.end(); }
