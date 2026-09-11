// Generates the device-trip fixtures. Encrypts a directory of JPEGs as assets
// and, if a thumbs/ subdirectory exists, as thumbnails under the same
// asset_id. Run on the desktop; the phone only fetches and decrypts.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import init, * as envelope from "../wasm/envelope.js";

const OUT = new URL("./fixtures/", import.meta.url);
const source = process.argv[2];
if (!source) {
  console.error("usage: node device/fixtures.mjs <dir-of-1600px-jpegs>");
  process.exit(2);
}

const hex = (b) => Buffer.from(b).toString("hex");

function uuidv4Bytes() {
  const b = new Uint8Array(16);
  webcrypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

async function jpegsIn(dir, required) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => /\.jpe?g$/i.test(n)).sort();
  } catch {
    if (!required) return [];
    console.error(`no such directory: ${dir}\nCreate it and put the 1600px JPEGs in it, with 320px copies in ${dir}/thumbs.`);
    process.exit(2);
  }
  return names.map((n) => new URL(n, `file://${dir.replace(/\/?$/, "/")}`));
}

await init({ module_or_path: await readFile(new URL("../wasm/envelope_bg.wasm", import.meta.url)) });

const albumKeyBytes = new Uint8Array(envelope.albumKeyLen());
webcrypto.getRandomValues(albumKeyBytes);
const album = envelope.AlbumKey.fromBytes(albumKeyBytes);

const assetFiles = await jpegsIn(source, true);
if (assetFiles.length === 0) throw new Error(`no JPEGs in ${source}`);
const thumbFiles = await jpegsIn(`${source.replace(/\/?$/, "")}/thumbs`, false);
if (thumbFiles.length === 0) console.warn("no thumbs/ subdirectory — measurement D will be skipped");
// Paired by filename, not by position: the two directories can diverge and an
// index pairing would silently attach a thumbnail to the wrong asset.
const thumbByName = new Map(thumbFiles.map((u) => [decodeURIComponent(u.pathname.split("/").pop()), u]));
if (assetFiles.length !== 20) console.warn(`${assetFiles.length} assets — §8's V.2 specifies twenty`);

await mkdir(new URL("./assets/", OUT), { recursive: true });
await mkdir(new URL("./thumbs/", OUT), { recursive: true });

const assets = [];
const thumbs = [];
for (const [i, file] of assetFiles.entries()) {
  const assetId = uuidv4Bytes();
  const plaintext = new Uint8Array(await readFile(file));
  const object = envelope.encryptAsset(album, assetId, plaintext);
  const name = `assets/${String(i).padStart(2, "0")}.bin`;
  await writeFile(new URL(`./${name}`, OUT), object);
  assets.push({ assetIdHex: hex(assetId), file: name, type: "image/jpeg", plaintextBytes: plaintext.length });

  const thumbFile = thumbByName.get(decodeURIComponent(file.pathname.split("/").pop()));
  if (thumbFile) {
    const thumbPlain = new Uint8Array(await readFile(thumbFile));
    const thumbObject = envelope.encryptThumb(album, assetId, thumbPlain);
    const thumbName = `thumbs/${String(i).padStart(2, "0")}.bin`;
    await writeFile(new URL(`./${thumbName}`, OUT), thumbObject);
    thumbs.push({ assetIdHex: hex(assetId), file: thumbName, type: "image/jpeg", plaintextBytes: thumbPlain.length });
  }
}

await writeFile(
  new URL("./manifest.json", OUT),
  JSON.stringify({ albumKeyHex: hex(albumKeyBytes), chunkSize: envelope.chunkSize(), assets, thumbs }, null, 2) + "\n",
);
album.free();
console.log(`${assets.length} assets, ${thumbs.length} thumbnails -> device/fixtures/`);
if (thumbs.length !== assets.length) console.warn(`${assets.length - thumbs.length} assets have no thumbnail — D measures only the ${thumbs.length} that do`);
