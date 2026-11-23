import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// The repaired production runtime injects a durable store; exercise that same seam.
const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=durable required repairs survive',
  'apps/desktop/test/courseware-native-tools.test.mjs'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });
await writeFile(new URL('../2026-11-17-durable-repairs/recreation-probe.log', import.meta.url), (result.stdout ?? '') + (result.stderr ?? ''));
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
