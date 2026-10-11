// SPDX-License-Identifier: AGPL-3.0-only
//
// Exports of Node builtins the browser build cannot provide (fs, net, ...).
// Importing them is fine; calling or constructing one throws a clear error.

export class NotAvailableInWebBuildError extends Error {
  override name = 'NotAvailableInWebBuildError';
}

export function unavailable(module: string, name: string): () => never {
  const api = `${module}.${name}`;
  return function notAvailable(): never {
    throw new NotAvailableInWebBuildError(
      `not available in the web build: ${api}`
    );
  };
}
