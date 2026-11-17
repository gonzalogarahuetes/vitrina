# JPEG quality — results

Decided 17 November 2026.

| Constant (`src/lib/owner/prepare.ts`) | Was  | Now      |
| ------------------------------------- | ---- | -------- |
| `ASSET_QUALITY`                       | 0.85 | **0.75** |
| `THUMB_QUALITY`                       | 0.80 | **0.70** |

0.70 showed no visible difference from 0.90 either, at fit or at the viewer's maximum zoom (4×), in both browsers. 0.75 was chosen for the photo for margin: the eye test used a low-sharpness phone and a Mac, and a photo's quality cannot be changed after upload.

## How it was measured

The page in this folder (`pnpm --filter @vitrina/web jpeg-quality`), run in each browser on the owner's camera originals. Every encode went through `prepare.ts`'s own `decode()` and `jpeg()`, so sizes are the bytes the app encrypts, after the segment filter. Sizes are per photo; the 30-photo album is the median × 30.

- **Chrome 156 / Android 10**: 8 photos. Six portraits stored 3000×4000, one landscape stored 4000×3000, one landscape stored 4640×3488. Two runs gave byte-identical sizes.
- **Safari / macOS**: 6 photos, a different set from Android's. Apple's encoder stands in for iPhone Safari; no iPhone was available. Its encode times are a Mac's, not a phone's.

## Numbers

| Browser                 | Kind      | Quality | Photos | Median kB | Largest kB | 30-photo album MB | vs current | Median encode ms |
| ----------------------- | --------- | ------- | ------ | --------- | ---------- | ----------------- | ---------- | ---------------- |
| Chrome 156 / Android 10 | photo     | 0.70    | 8      | 312.3     | 578.7      | 9.37              | −35%       | 104              |
| Chrome 156 / Android 10 | photo     | **0.75** | 8     | 347.7     | 635.9      | 10.43             | −27%       | 84               |
| Chrome 156 / Android 10 | photo     | 0.80    | 8      | 402.4     | 719.6      | 12.07             | −16%       | 90               |
| Chrome 156 / Android 10 | photo     | 0.85    | 8      | 479.2     | 829.2      | 14.38             | —          | 97               |
| Chrome 156 / Android 10 | photo     | 0.90    | 8      | 610.8     | 998.1      | 18.32             | +27%       | 114              |
| Chrome 156 / Android 10 | thumbnail | **0.70** | 8     | 31.6      | 49.4       | 0.95              | −22%       | 30               |
| Chrome 156 / Android 10 | thumbnail | 0.75    | 8      | 35.1      | 55.0       | 1.05              | −14%       | 24               |
| Chrome 156 / Android 10 | thumbnail | 0.80    | 8      | 40.7      | 63.0       | 1.22              | —          | 26               |
| Safari / macOS          | photo     | 0.70    | 6      | 515.6     | 1,145.4    | 15.47             | −28%       | 39               |
| Safari / macOS          | photo     | **0.75** | 6     | 566.9     | 1,227.5    | 17.01             | −21%       | 20               |
| Safari / macOS          | photo     | 0.80    | 6      | 610.0     | 1,296.4    | 18.30             | −15%       | 20               |
| Safari / macOS          | photo     | 0.85    | 6      | 717.4     | 1,455.8    | 21.52             | —          | 20               |
| Safari / macOS          | photo     | 0.90    | 6      | 758.6     | 1,520.5    | 22.76             | +6%        | 21               |
| Safari / macOS          | thumbnail | **0.70** | 6     | 67.9      | 112.0      | 2.04              | −14%       | 4                |
| Safari / macOS          | thumbnail | 0.75    | 6      | 74.1      | 120.2      | 2.22              | −7%        | 3                |
| Safari / macOS          | thumbnail | 0.80    | 6      | 79.4      | 127.6      | 2.38              | —          | 4                |

"vs current" compares the median with 0.85 (photo) or 0.80 (thumbnail).

## One chunk

The largest thumbnail measured at 0.70 is 112,031 bytes (Safari), 43% of the 262,144-byte chunk a thumbnail must fit in (`thumb-too-large`).
