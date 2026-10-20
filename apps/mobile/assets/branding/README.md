# Brand assets (step 7.9)

Since 2026-10-21 the files are the **"Sajilo cha hai" artwork**, cut from the approved brand mockups:
the customer app has the "Hamro Pasal - sajilo cha hai" icon and the round emblem (a Nepali shop under
the Himalaya); the Seller app has the "Hamro Pasal Vendor" icon. They were cropped from the mockup
renderings (not from vector masters), so replace each one with the designer's export when it exists,
**under the same file name**. The two `notification-icon.png` files are still **placeholders**: Android
needs a white silhouette, which the illustrations cannot provide. `app.config.ts` picks the folder from
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

`BrandMark`, `BrandLockup` and `BasketLoader` in `src/ui/Brand.tsx` draw `logo.png` for the running build
and `assets/images/basket-loader.png`. The wordmark ("Hamro Pasal", the tagline) is text in the Outfit
font, not part of the image, so it stays sharp and follows the language. `LogoPlaceholder` in
`src/features/boot/SplashView.tsx` keeps its name and `testID` and now renders `BrandMark`.

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
