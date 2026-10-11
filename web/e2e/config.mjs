// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the end-to-end test build (renderer/build.mjs --e2e) and the
// test runner (e2e/run.mjs): where the test relay listens, and the config
// that points the app at Desktop's mock server instead of Signal.
//
// The app connects to https://localhost (port 443, the name in the mock
// server's certificate); the relay carries those connections to the port
// the mock server actually listens on.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const MOCK_SERVER_PACKAGE = join(REPO, 'packages/mock-server');

export const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 18791);
export const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}/`;
export const MOCK_HOST = 'localhost';
export const MOCK_PORT = 443;
export const MOCK_URL = `https://${MOCK_HOST}`;

/**
 * Overrides for the app's static config, as ts/test-mock/bootstrap.node.ts
 * gives Desktop (its #generateConfig and the mock's loadCertificates()).
 */
export function mockServerConfig() {
  const certs = join(MOCK_SERVER_PACKAGE, 'certs');
  const zk = JSON.parse(readFileSync(join(certs, 'zk-params.json'), 'utf8'));
  const trustRoot = JSON.parse(readFileSync(join(certs, 'trust-root.json'), 'utf8'));
  return {
    serverUrl: MOCK_URL,
    storageUrl: `${MOCK_URL}/storageService`,
    resourcesUrl: `${MOCK_URL}/updates2`,
    sfuUrl: `${MOCK_URL}/callingService`,
    cdnUrl0: MOCK_URL,
    cdnUrl2: MOCK_URL,
    cdnUrl3: `${MOCK_URL}/cdn3`,
    certificateAuthority: readFileSync(join(certs, 'ca-cert.pem'), 'utf8'),
    serverPublicParams: zk.publicParams,
    genericServerPublicParams: zk.genericPublicParams,
    backupServerPublicParams: zk.backupPublicParams,
    serverTrustRoots: [trustRoot.publicKey],
  };
}
