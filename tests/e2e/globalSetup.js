// tests/e2e/globalSetup.js
import { execSync } from 'child_process';

export default async function globalSetup() {
  console.log('Building extension before E2E tests...');
  execSync('npm run build', { stdio: 'inherit' });
}
