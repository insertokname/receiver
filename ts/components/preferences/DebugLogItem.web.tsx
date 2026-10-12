// SPDX-License-Identifier: AGPL-3.0-only

// Web build: the web app has no native menu, so Desktop's Help > Debug log
// is an item in Settings > General. It opens the same view (copy, save).

import type { ReactNode } from 'react';
import type { LocalizerType } from '../../types/Util.std.ts';
import { AxoItem } from '../../axo/items/AxoItem.dom.tsx';
import { AxoList } from '../../axo/items/AxoList.dom.tsx';
import { AxoClickableItem } from '../../axo/items/AxoClickableItem.dom.tsx';

export function DebugLogItem({ i18n }: { i18n: LocalizerType }): ReactNode {
  return (
    <AxoList.Root>
      <AxoList.Body>
        <AxoItem.Group>
          <AxoClickableItem.Root
            label={i18n('icu:submitDebugLog')}
            arrow="next"
            onClick={() => window.IPC.showDebugLog()}
          />
        </AxoItem.Group>
      </AxoList.Body>
    </AxoList.Root>
  );
}
