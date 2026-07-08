import { ensureCdnCache } from './support/cdn.mjs';

export default async function globalSetup() {
  await ensureCdnCache();
}
