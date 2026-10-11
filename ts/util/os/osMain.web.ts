// SPDX-License-Identifier: AGPL-3.0-only

// Web build: Desktop runs its Linux code paths in the browser, and names a
// new linked device after OS.getName() ("Linux"). Here that name is the
// browser's, like WhatsApp Web's: "receiver (Chrome, macOS)". getName() is
// otherwise only used in messages about unsupported OS versions, which the
// web build never shows. There is no /etc/os-release, AppImage, Flatpak,
// KDE or Wayland to detect in a browser.

import os from 'node:os';

import { getOSFunctions } from './shared.std.ts';
import { deviceName } from '../../../web/shell/device-name.ts';

const OS = {
  ...getOSFunctions(os.release()),
  getName: (): string => deviceName(),
  getLinuxName: (): string | undefined => undefined,
  isAppImage: (): boolean => false,
  isFlatpak: (): boolean => false,
  isLinuxUsingKDE: (): boolean => false,
  isWaylandEnabled: (): boolean => false,
};

export default OS;
