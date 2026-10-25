import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local';

async function boundedRead(path) {
  if ((await stat(path)).size > 256 * 1024) throw new Error('shared_model_file_too_large');
  return readFile(path, 'utf8');
}

export async function loadSharedModel({ sessionFile = process.env.GENERIC_JINBAO_SESSION_FILE,
  dshHome = join(homedir(), '.dsh'), read = boundedRead, now = Date.now,
  sessionToken = process.env.GENERIC_JINBAO_SESSION_TOKEN } = {}) {
  if (!isAbsolute(dshHome) || (sessionFile && !isAbsolute(sessionFile))) throw new Error('absolute_credential_path_required');
  async function resolveCredential() {
    try {
      let value;
      if (sessionFile) {
        const document = JSON.parse(await read(sessionFile));
        if (!Number.isSafeInteger(document.expiresAt) || document.expiresAt <= now()) throw 0;
        value = document.sessionToken;
      } else {
        value = sessionToken ?? parseCredentialsDocument(await read(join(dshHome, '.credentials.yaml')),
          'native_credentials').refs.get('JINBAO_SERVICE_TOKEN');
      }
      if (typeof value !== 'string' || !/^j[cd]_[a-f0-9]{64}$/.test(value)) throw 0;
      return { value };
    } catch { throw new Error('jinbao_server_credential_unavailable'); }
  }
  await resolveCredential();
  const summary = { mode: sessionFile ? 'jinbao_server_development_session' : 'jinbao_server_user_session',
    provider: 'jinbao-server', model: 'game-fast', upstream_provider: 'opencode_go',
    upstream_model: 'deepseek-v4.1-flash', endpoint: 'https://api.jinbaoai.top/v1/chat/completions',
    credential_ref: sessionFile ? 'GENERIC_JINBAO_SESSION_FILE' : 'JINBAO_SERVICE_TOKEN' };
  // The alias resolves server-side. Neither upstream keys nor admin credentials are loaded.
  return { provider: summary.provider, model: summary.model, baseURL: 'https://api.jinbaoai.top/v1',
    credentialRef: 'GENERIC_JINBAO_CREDENTIAL', resolveCredential, summary };
}
