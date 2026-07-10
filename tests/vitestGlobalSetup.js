// tests/vitestGlobalSetup.js
import { execSync } from 'child_process';

export default async function () {
  execSync('npm run build', { stdio: 'inherit' });
}
