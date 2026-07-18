import { startProgressivePage } from './progressive-page.js';

startProgressivePage().catch(error => {
  console.warn('[STPT] Progressive content startup failed:', error);
});
