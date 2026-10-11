// SPDX-License-Identifier: AGPL-3.0-only
//
// The renderer config ('get-config'): the static part generated at build
// time from config/default.json + config/production.json (see
// renderer/build.mjs), plus what Electron's main process reads from the OS,
// here from the browser. Validated with Desktop's own schema, as main does.

import staticConfig from 'virtual:web-static-config';

import {
  rendererConfigSchema,
  type RendererConfigType,
} from '../../ts/types/RendererConfig.std.ts';
import { HourCyclePreference } from '../../ts/types/I18N.std.ts';
import { ThemeType } from '../../ts/types/Util.std.ts';
import type { WebLocale } from './locale.ts';
import { getThemeSetting, prefersDark } from './settings.ts';

// Virtual paths: the web build has no file system. Phase 3 maps the
// attachment / sticker / draft directories under userData to OPFS.
const PATHS = {
  userDataPath: '/userData',
  homePath: '/home',
  installPath: '/app',
  crashDumpsPath: '/userData/crashDumps',
};

export function createConfig(locale: WebLocale): RendererConfigType {
  const themeSetting = getThemeSetting();
  const theme =
    themeSetting === 'system'
      ? prefersDark()
        ? ThemeType.dark
        : ThemeType.light
      : ThemeType[themeSetting];

  const result = rendererConfigSchema.safeParse({
    ...staticConfig,
    ...PATHS,
    availableLocales: locale.availableLocales,
    resolvedTranslationsLocale: locale.name,
    resolvedTranslationsLocaleDirection: locale.direction,
    hourCyclePreference: HourCyclePreference.UnknownPreference,
    preferredSystemLocales: locale.preferredSystemLocales,
    localeOverride: locale.localeOverride,
    isMockTestEnvironment: false,
    disableIPv6: false,
    disableScreenSecurity: false,
    nodeVersion: '24.0.0',
    hostname: 'receiver',
    osRelease: '0.0.0',
    osVersion: 'web',
    appInstance: undefined,
    proxyUrl: undefined,
    reducedMotionSetting: matchMedia('(prefers-reduced-motion: reduce)').matches,
    theme,
    appStartInitialSpellcheckSetting: false,
    isMainWindowFullScreen: false,
    isMainWindowMaximized: false,
    argv: undefined,
  });

  if (!result.success) {
    throw new Error(`web main: invalid renderer config: ${result.error.message}`);
  }
  return result.data;
}
