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

export function listKeysStreaming(
  dbPath: string,
  bucketPath: string,
  onItem: (item: any) => void,
  onProgress: (progress: any) => void,
  onComplete: (complete: any) => void,
  onError: (error: string) => void,
  opts: { prefix?: string, limit?: number, afterKey?: string } = {}
): { cancel: () => void } {
  const args = ['lsk', '--db', dbPath, '--path', bucketPath, '--stream'];
  if (opts.prefix) { args.push('--prefix', opts.prefix); }
  if (opts.limit) { args.push('--limit', String(opts.limit)); }
  if (opts.afterKey) { args.push('--after-key', opts.afterKey); }

  const bin = getPlatformBinary();
  console.log('[DEBUG] Streaming listKeys:', bin, args.join(' '));
  
  const proc = cp.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          switch (message.type) {
            case 'item':
              onItem(message.item);
              break;
            case 'progress':
              onProgress(message.progress);
              break;
            case 'complete':
              onComplete(message.complete);
              break;
            case 'error':
              onError(message.error);
              break;
          }
        } catch (e) {
          console.error('Failed to parse streaming listKeys message:', line, e);
        }
      }
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    console.log('[DEBUG] Streaming listKeys stderr:', data.toString());
  });

  proc.on('close', (code) => {
    console.log(`[DEBUG] Streaming listKeys finished with code ${code}`);
    if (code !== 0 && code !== null) {
      onError(`ListKeys process exited with code ${code}`);
    }
  });

  proc.on('error', (err) => {
    console.error('[DEBUG] Streaming listKeys error:', err);
    onError(err.message);
  });

  return {
    cancel: () => {
      console.log('[DEBUG] Cancelling listKeys process:', proc.pid);
      proc.kill('SIGTERM');
      // Force kill if still running after 1 second
      setTimeout(() => {
        if (!proc.killed) {
          console.log('[DEBUG] Force killing listKeys process');
          proc.kill('SIGKILL');
        }
      }, 1000);
    }
  };
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
export async function search(dbPath: string, query: string, limit: number = 100, caseSensitive: boolean = false, searchType: string = 'both') {
  const args = ['search', '-db', dbPath, '-query', query, '-limit', limit.toString()];
  if (caseSensitive) {
    args.push('-case-sensitive');
  }
  if (searchType !== 'both') {
    args.push('-type', searchType);
  }
  return execJson(args);
}

export function searchStreaming(
  dbPath: string, 
  query: string, 
  onResult: (item: any) => void,
  onProgress: (progress: any) => void,
  onComplete: (summary: any) => void,
  onError: (error: string) => void,
  limit: number = 100, 
  caseSensitive: boolean = false, 
  searchType: string = 'both',
  maxDepth: number = -1,
  exactMatch: boolean = false
): { cancel: () => void } {
  const args = ['search', '-db', dbPath, '-query', query, '-limit', limit.toString(), '-stream'];
  if (caseSensitive) {
    args.push('-case-sensitive');
  }
  if (searchType !== 'both') {
    args.push('-type', searchType);
  }
  if (maxDepth >= 0) {
    args.push('-max-depth', maxDepth.toString());
  }
  if (exactMatch) {
    args.push('-exact-match');
  }

  const bin = getPlatformBinary();
  console.log('[DEBUG] Streaming search:', bin, args.join(' '));
  
  const proc = cp.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          switch (message.type) {
            case 'result':
              onResult(message.item);
              break;
            case 'progress':
              onProgress(message.progress);
              break;
            case 'complete':
              onComplete(message.summary);
              break;
            case 'error':
              onError(message.error);
              break;
          }
        } catch (e) {
          console.error('Failed to parse streaming message:', line, e);
        }
      }
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    console.log('[DEBUG] Streaming search stderr:', data.toString());
  });

  proc.on('close', (code) => {
    console.log(`[DEBUG] Streaming search finished with code ${code}`);
    if (code !== 0 && code !== null) {
      onError(`Search process exited with code ${code}`);
    }
  });

  proc.on('error', (err) => {
    console.error('[DEBUG] Streaming search error:', err);
    onError(err.message);
  });

  return {
    cancel: () => {
      console.log('[DEBUG] Cancelling search process:', proc.pid);
      proc.kill('SIGTERM');
      // Force kill if still running after 1 second
      setTimeout(() => {
        if (!proc.killed) {
          console.log('[DEBUG] Force killing search process');
          proc.kill('SIGKILL');
        }
      }, 1000);
    }
  };
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
