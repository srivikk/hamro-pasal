import type { ExpoConfig } from 'expo/config';

import appConfig from '../../app.config';
import { colors, palette, schemeColors } from './colors';

// Typed structurally: the app's tsconfig does not load Node's type definitions.
const fs = jest.requireActual<{
  readFileSync: ((path: string, encoding: 'utf8') => string) & ((path: string) => Uint8Array);
}>('node:fs');
const path = jest.requireActual<{ join: (...parts: string[]) => string }>('node:path');

// Jest's own global; declared here because Node's types are not loaded.
declare const __dirname: string;

const MOBILE_ROOT = path.join(__dirname, '..', '..');

function configFor(variant: string | undefined): ExpoConfig {
  const previous = process.env.APP_VARIANT;
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  try {
    return appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  } finally {
    if (previous === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previous;
  }
}

function pluginOptions(config: ExpoConfig, name: string): Record<string, unknown> {
  const entry = config.plugins?.find((p) => Array.isArray(p) && p[0] === name);
  if (!Array.isArray(entry)) throw new Error(`${name} is not configured`);
  return entry[1] as Record<string, unknown>;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(relativePath: string): { width: number; height: number } {
  const file = fs.readFileSync(path.join(MOBILE_ROOT, relativePath));
  const bytes = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(String.fromCharCode(...file.subarray(1, 4))).toBe('PNG');
  return { width: bytes.getUint32(16), height: bytes.getUint32(20) };
}

describe('branding (step 7.9)', () => {
  it.each([
    ['customer', 'customer', palette.brand.DEFAULT],
    ['seller', 'seller', palette.brand.dark],
  ])('the %s build takes its own assets and accent', (variant, folder, accent) => {
    const config = configFor(variant);
    const dir = `./assets/branding/${folder}`;
    expect(config.icon).toBe(`${dir}/icon.png`);
    expect(config.android?.adaptiveIcon).toEqual({
      foregroundImage: `${dir}/adaptive-icon.png`,
      backgroundColor: accent,
    });
    expect(pluginOptions(config, 'expo-splash-screen')).toMatchObject({
      image: `${dir}/splash-icon.png`,
      backgroundColor: accent,
      dark: { image: `${dir}/splash-icon.png`, backgroundColor: palette.surface.dark },
    });
    expect(pluginOptions(config, 'expo-notifications')).toMatchObject({
      icon: `${dir}/notification-icon.png`,
      color: palette.brand.DEFAULT,
      defaultChannel: 'orders',
    });
  });

  it('defaults to the customer build', () => {
    expect(configFor(undefined).icon).toBe('./assets/branding/customer/icon.png');
  });

  it.each(['customer', 'seller'])('every %s asset exists at the size the README asks for', (v) => {
    const dir = `assets/branding/${v}`;
    expect(pngSize(`${dir}/icon.png`)).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(`${dir}/adaptive-icon.png`)).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(`${dir}/splash-icon.png`)).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(`${dir}/notification-icon.png`)).toEqual({ width: 96, height: 96 });
    expect(pngSize(`${dir}/logo.png`)).toEqual({ width: 512, height: 512 });
  });

  it('builds the raw colours and both schemes from the palette', () => {
    expect(colors).toMatchObject({
      brand: '#C8102E',
      brandDark: '#9E0C24',
      success: '#059669',
      inactive: '#737373',
    });
    expect(schemeColors.dark.surface).toBe(palette.surface.dark);
    expect(schemeColors.light.text).toBe(palette.ink.DEFAULT);
  });

  it('gives Tailwind the same palette', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tailwind = require('../../tailwind.config.js') as {
      theme: { extend: { colors: unknown } };
    };
    expect(tailwind.theme.extend.colors).toEqual(palette);
  });

  it('keeps the admin dashboard brand tokens in step', () => {
    const css = fs.readFileSync(path.join(MOBILE_ROOT, '..', 'admin', 'src', 'styles.css'), 'utf8');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
    const token = (name: string) =>
      new RegExp(`--${name}: (#[0-9a-f]{6});`, 'i').exec(light)?.[1]?.toUpperCase();
    expect(token('brand')).toBe(palette.brand.DEFAULT);
    expect(token('brand-dark')).toBe(palette.brand.dark);
    expect(token('brand-light')).toBe(palette.brand.light);
  });
});
