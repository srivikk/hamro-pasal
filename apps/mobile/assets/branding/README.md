# Brand assets (step 7.9)

Every file in `customer/` and `seller/` is a **placeholder** (a plain disc). Replace each one with
the final artwork **under the same file name**. `app.config.ts` picks the folder from
`APP_VARIANT`, and `src/theme/branding.test.ts` fails if a file is missing or the wrong size.

| File                    | Size (px)   | Format and rules                                                                                                                         | Used for                                 |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `icon.png`              | 1024 × 1024 | PNG, square, **no transparency**, no rounded corners (the stores round them)                                                             | iOS app icon, Play Store listing         |
| `adaptive-icon.png`     | 1024 × 1024 | PNG, transparent background; keep the logo inside the centre 66% (about 676 px), because Android crops the edges to a circle or squircle | Android launcher icon (foreground layer) |
| `splash-icon.png`       | 1024 × 1024 | PNG, transparent background, the logo mark only. It is drawn 200 px wide in the middle of the screen                                     | Splash screen, light and dark            |
| `notification-icon.png` | 96 × 96     | PNG, **white silhouette on a transparent background**, no colour. Android tints it with the brand red                                    | Android status-bar push icon             |
| `logo.png`              | 512 × 512   | PNG, transparent background                                                                                                              | In-app logo (see "In-app logo" below)    |

You can supply the same artwork in both folders, or a Seller version (for example the logo with a
"Seller" badge) so the two apps are easy to tell apart on one phone.

## Colours

The background colours are not in the images. They come from `src/theme/palette.json`:

- **Adaptive icon and light splash background:** the brand red `brand.DEFAULT` (Customer) or
  `brand.dark` (Seller). This is the `accent` field in `app.config.ts`.
- **Dark splash background:** `surface.dark`.
- **Notification tint:** `brand.DEFAULT`.

Change a colour in `palette.json` and it changes everywhere: Tailwind classes, `colors.ts`, and
these native settings. Keep `--brand*` in `apps/admin/src/styles.css` the same as `palette.json`;
the branding test checks this.

## In-app logo

The boot splash, Welcome, Language and About screens draw `LogoPlaceholder` in
`src/features/boot/SplashView.tsx`. When `logo.png` is final, change that component to render it:

```tsx
<Image source={isSellerApp() ? sellerLogo : customerLogo} style={{ width: size, height: size }} />
```

Here `sellerLogo` and `customerLogo` are `require()`s of the two `logo.png` files. Keep the
component's name and `testID`.

The Welcome auth-wall photo is shared by both apps:
`assets/images/auth-wall-placeholder.png`. Replace that file and keep its name.

## Seeing the new assets

Native assets are not hot-reloaded. After you replace any file, regenerate the native project and
rebuild:

```sh
cd apps/mobile
APP_VARIANT=seller npx expo prebuild --clean   # or APP_VARIANT=customer
APP_VARIANT=seller npx expo run:android
```

Or build in the cloud with `eas build --profile seller-development --platform android`.
