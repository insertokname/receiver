// SPDX-License-Identifier: AGPL-3.0-only
//
// Shows a boot failure with Desktop's own error dialog (React), once the
// preload graph (and with it window.SignalContext.i18n) is available.
// Closing the dialog reloads the page to try again.

import { createRoot } from 'react-dom/client';

import { AppProvider } from '../../ts/windows/AppProvider.dom.tsx';
import { ErrorModal } from '../../ts/components/ErrorModal.dom.tsx';

export function showBootError(description: string): void {
  const { i18n } = window.SignalContext;
  const container = document.createElement('div');
  container.className = 'web-boot-error';
  document.body.appendChild(container);
  createRoot(container).render(
    <AppProvider>
      <ErrorModal
        i18n={i18n}
        title={i18n('icu:ErrorModal--title')}
        description={description}
        onClose={() => window.location.reload()}
      />
    </AppProvider>
  );
}
