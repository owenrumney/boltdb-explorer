import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as fs from 'fs';

const BIN_DIR = path.join(__dirname, '..', 'bin');

function getPlatformBinary(): string {
  const platform = os.platform();
  const arch = os.arch();
  let bin = 'bolthelper-';
  if (platform === 'darwin') { bin += 'darwin-'; }
  else if (platform === 'linux') { bin += 'linux-'; }
  else if (platform === 'win32') { bin += 'windows-'; }
  else { throw new Error('Unsupported platform: ' + platform); }
  if (arch === 'arm64') { bin += 'arm64'; }
  else if (arch === 'x64') { bin += 'amd64'; }
  else { throw new Error('Unsupported arch: ' + arch); }
  if (platform === 'win32') { bin += '.exe'; }
  const binPath = path.join(BIN_DIR, bin);
  if (!fs.existsSync(binPath)) { throw new Error('Missing helper binary: ' + binPath); }
  return binPath;
}

function execJson(args: string[], opts: cp.SpawnOptions = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const bin = getPlatformBinary();
    console.log('[DEBUG] Executing:', bin, args.join(' '));
    const startTime = Date.now();
    const proc = cp.spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => {
      err += d;
      console.log('[DEBUG] Go stderr:', d.toString());
    });
    proc.on('close', code => {
      const duration = Date.now() - startTime;
      console.log(`[DEBUG] Go process finished in ${duration}ms with code ${code}`);
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      } else {
        reject(new Error(err || `exit code ${code}`));
      }
    });
    proc.on('error', (err) => {
      console.log('[DEBUG] Go process error:', err);
      reject(err);
    });
  });
}

export async function getMeta(dbPath: string) {
  return execJson(['meta', '--db', dbPath]);
}

export async function isBoltDB(dbPath: string): Promise<boolean> {
  try {
    await getMeta(dbPath);
    return true;
  } catch (error) {
    return false;
  }
}
export async function listBuckets(dbPath: string, bucketPath: string) {
  return execJson(['lsb', '--db', dbPath, '--path', bucketPath]);
}
export async function listKeys(dbPath: string, bucketPath: string, opts: { prefix?: string, limit?: number, afterKey?: string } = {}) {
  console.time(`boltClient-listKeys-${bucketPath || 'root'}`);
  const args = ['lsk', '--db', dbPath, '--path', bucketPath];
  console.log('[DEBUG] listKeys args:', args);
  if (opts.prefix) { args.push('--prefix', opts.prefix); }
  if (opts.limit) { args.push('--limit', String(opts.limit)); }
  if (opts.afterKey) { args.push('--after-key', opts.afterKey); }
  console.log('[DEBUG] Final listKeys args:', args);
  const result = await execJson(args);
  console.timeEnd(`boltClient-listKeys-${bucketPath || 'root'}`);
  return result;
}
export async function readHead(dbPath: string, bucketPath: string, keyBase64: string, n = 65536) {
  return execJson(['get', '--db', dbPath, '--path', bucketPath, '--key', keyBase64, '--mode', 'head', '--n', String(n)]);
}
export async function saveToFile(dbPath: string, bucketPath: string, keyBase64: string, outPath: string) {
  return execJson(['get', '--db', dbPath, '--path', bucketPath, '--key', keyBase64, '--mode', 'save', '--out', outPath]);
}
export async function exportBucket(dbPath: string, bucketPath: string, outPath: string, prefix?: string) {
  const args = ['export', '--db', dbPath, '--out', outPath];
  if (bucketPath) { args.push('--path', bucketPath); }
  if (prefix) { args.push('--prefix', prefix); }
  return execJson(args);
}
export async function search(dbPath: string, query: string, limit: number = 100, caseSensitive: boolean = false) {
  const args = ['search', '-db', dbPath, '-query', query, '-limit', limit.toString()];
  if (caseSensitive) {
    args.push('-case-sensitive');
  }
  return execJson(args);
}

// Write operations
export async function createBucket(dbPath: string, bucketPath: string) {
  return execJson(['write', '--db', dbPath, '--op', 'create-bucket', '--path', bucketPath]);
}

export async function putKeyValue(dbPath: string, bucketPath: string, keyBase64: string, valueBase64: string) {
  return execJson(['write', '--db', dbPath, '--op', 'put', '--path', bucketPath, '--key', keyBase64, '--value', valueBase64]);
}

export async function deleteKey(dbPath: string, bucketPath: string, keyBase64: string) {
  return execJson(['write', '--db', dbPath, '--op', 'delete-key', '--path', bucketPath, '--key', keyBase64]);
}

export async function deleteBucket(dbPath: string, bucketPath: string) {
  return execJson(['write', '--db', dbPath, '--op', 'delete-bucket', '--path', bucketPath]);
}
