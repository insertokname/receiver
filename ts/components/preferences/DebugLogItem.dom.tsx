// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';
import type { LocalizerType } from '../../types/Util.std.ts';

// The debug log in Settings > General. Desktop has it in its Help menu
// instead; the web build, without a native menu, shows it here
// (DebugLogItem.web.tsx).
export function DebugLogItem(_props: { i18n: LocalizerType }): ReactNode {
  return null;
}
