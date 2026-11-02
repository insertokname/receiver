// SPDX-License-Identifier: AGPL-3.0-only

// Web build: the web app has no native menu, so Desktop's Help > Debug log
// is an item in Settings > General. It opens the same view (copy, save).

import type { ReactNode } from 'react';
import type { LocalizerType } from '../../types/Util.std.ts';
import { AxoClickableItem } from '../../axo/items/AxoClickableItem.dom.tsx';
import { PreferencesList } from './PreferencesList.dom.tsx';

export function DebugLogItem({ i18n }: { i18n: LocalizerType }): ReactNode {
  return (
    <PreferencesList>
      <AxoClickableItem.Root
        label={i18n('icu:submitDebugLog')}
        arrow="next"
        onClick={() => window.IPC.showDebugLog()}
      />
    </PreferencesList>
  );
}
