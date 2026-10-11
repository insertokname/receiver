// SPDX-License-Identifier: AGPL-3.0-only
//
// Locale loading, as app/locale.node.ts does for packaged builds: the best
// match of the browser's languages (or the user's override) among Desktop's
// locales, compact message files merged over English.

import { match } from '@formatjs/intl-localematcher';
import localAssets from 'virtual:web-local-assets';

import type { LocaleMessagesType } from '../../ts/types/I18N.std.ts';
import { getStored } from './storage.ts';

export type WebLocale = {
  availableLocales: Array<string>;
  name: string;
  direction: 'ltr' | 'rtl';
  messages: LocaleMessagesType;
  preferredSystemLocales: Array<string>;
  localeOverride: string | null;
  localeDisplayNames: Record<string, Record<string, string>>;
  countryDisplayNames: Record<string, Record<string, string>>;
};

const BASE = new URL('./locales/', document.baseURI);

async function fetchJson<T>(path: string): Promise<T> {
  // Checked against the digest recorded at build time.
  const integrity = localAssets.locales[path];
  if (!integrity) {
    throw new Error(`locale: ${path}: not part of this build`);
  }
  const response = await fetch(new URL(path, BASE), { integrity });
  if (!response.ok) {
    throw new Error(`locale: ${path}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function getDirection(locale: string): 'ltr' | 'rtl' {
  const info = new Intl.Locale(locale) as Intl.Locale & {
    getTextInfo?: () => { direction?: 'ltr' | 'rtl' };
    textInfo?: { direction?: 'ltr' | 'rtl' };
  };
  return info.getTextInfo?.().direction ?? info.textInfo?.direction ?? 'ltr';
}

// The app's name (trademark): Desktop's strings call the app "Signal
// Desktop"; this app is receiver. "Signal" alone stays where it names the
// Signal service or the phone app ("Open Signal on your phone"); these keys
// use it for the app itself.
const APP_NAME_KEYS = new Set(['icu:welcomeToSignal']);

function withAppName(key: string, text: string | null | undefined): string | undefined {
  if (text == null) {
    return undefined;
  }
  const renamed = text.replaceAll('Signal Desktop', 'receiver');
  return APP_NAME_KEYS.has(key) ? renamed.replaceAll('Signal', 'receiver') : renamed;
}

export async function loadLocale(): Promise<WebLocale> {
  const availableLocales = await fetchJson<Array<string>>('available-locales.json');
  const preferredSystemLocales = navigator.languages?.length
    ? [...navigator.languages]
    : [navigator.language || 'en'];
  const localeOverride = getStored<string | null>('localeOverride') ?? null;

  const name = match(
    localeOverride != null ? [localeOverride] : preferredSystemLocales,
    availableLocales,
    'en',
    { algorithm: 'best fit' }
  );

  const [keys, english, matched, localeDisplayNames, countryDisplayNames] =
    await Promise.all([
      fetchJson<Array<string>>('keys.json'),
      fetchJson<Array<string | null>>('en/values.json'),
      name === 'en'
        ? Promise.resolve(null)
        : fetchJson<Array<string | null>>(`${name}/values.json`),
      fetchJson<WebLocale['localeDisplayNames']>('locale-display-names.json'),
      fetchJson<WebLocale['countryDisplayNames']>('country-display-names.json'),
    ]);
  for (const [locale, values] of [['en', english], [name, matched ?? english]] as const) {
    if (values.length !== keys.length) {
      throw new Error(`locale: invalid "${locale}" entry count, ${values.length} != ${keys.length}`);
    }
  }

  const messages: LocaleMessagesType = Object.create(null);
  for (const [i, key] of keys.entries()) {
    messages[key] = {
      messageformat: withAppName(key, matched?.[i] ?? english[i]),
    } as LocaleMessagesType[string];
  }

  return {
    availableLocales,
    name,
    direction: getDirection(name),
    messages,
    preferredSystemLocales,
    localeOverride,
    localeDisplayNames,
    countryDisplayNames,
  };
}
