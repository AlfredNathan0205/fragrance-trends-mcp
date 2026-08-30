import { spawn } from 'node:child_process';

function run(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'packages/mcp/src/stdio.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const missingKey = await run({ FTM_MODE: 'licensed', FTM_API_KEY: '' });
if (missingKey.code === 0 || !missingKey.stderr.includes('FTM_API_KEY is required')) {
  throw new Error('Licensed mode did not fail closed when its API key was missing.');
}

const disabledLiveMode = await run({
  FTM_MODE: 'licensed',
  FTM_API_KEY: 'ftm_test_boundary_only',
});
if (
  disabledLiveMode.code === 0 ||
  !disabledLiveMode.stderr.includes('Licensed mode is intentionally disabled')
) {
  throw new Error('Licensed mode started without rights-approved production adapters.');
}

console.log('Mode boundary check passed.');
