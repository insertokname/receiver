// SPDX-License-Identifier: AGPL-3.0-only
// node:os for the browser: fixed values matching process.platform ('linux').
// Nothing here identifies the user's machine.

export const EOL = '\n';
export const platform = (): string => 'linux';
export const type = (): string => 'Linux';
export const arch = (): string => 'x64';
export const release = (): string => '0.0.0';
export const version = (): string => 'web';
export const hostname = (): string => 'receiver';
export const homedir = (): string => '';
export const tmpdir = (): string => '/tmp';
export const endianness = (): 'LE' => 'LE';
export const cpus = (): Array<unknown> => [];
export const availableParallelism = (): number =>
  navigator.hardwareConcurrency || 1;
export const totalmem = (): number => 0;
export const freemem = (): number => 0;
export const uptime = (): number => performance.now() / 1000;
export const loadavg = (): Array<number> => [0, 0, 0];
export const networkInterfaces = (): Record<string, never> => ({});
export const userInfo = () => ({
  username: '',
  uid: -1,
  gid: -1,
  shell: null,
  homedir: '',
});
export const constants = { signals: {}, errno: {} };

export default {
  EOL,
  platform,
  type,
  arch,
  release,
  version,
  hostname,
  homedir,
  tmpdir,
  endianness,
  cpus,
  availableParallelism,
  totalmem,
  freemem,
  uptime,
  loadavg,
  networkInterfaces,
  userInfo,
  constants,
};
