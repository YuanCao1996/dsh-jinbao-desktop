import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

export function assertSdkSingleton(resolve = createRequire(import.meta.url)) {
  try {
    const scope = realpathSync(resolve.resolve('@deepseek-ai/dsh-scope'));
    for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
      const dependency = createRequire(resolve.resolve(name));
      if (realpathSync(dependency.resolve('@deepseek-ai/dsh-scope')) !== scope) {
        throw new Error('dsh_sdk_instance_mismatch');
      }
    }
  } catch {
    throw new Error('dsh_sdk_instance_mismatch');
  }
}
