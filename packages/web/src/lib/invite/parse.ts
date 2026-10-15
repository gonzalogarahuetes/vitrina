import { decodeBase64url } from "@vitrina/shared";
import type { ParseInvite } from "./types";

const V_REGEX = /^[1-9][0-9]*$/;
const allowedKeys = ["a", "t", "v", "k"];

export const parseInvite: ParseInvite = (hash: string) => {
  if (!hash || hash === "#") {
    return { ok: false, error: { kind: "missing" } };
  }

  if (!hash.startsWith("#")) {
    return { ok: false, error: { kind: "malformed" } };
  }

  const stripped = hash.substring(1);

  const vPieces = stripped.split("&").filter((p) => p.startsWith("v="));
  if (vPieces.length !== 1) return { ok: false, error: { kind: "malformed" } };
  const v = vPieces[0]!.slice(2);
  if (!V_REGEX.test(v)) return { ok: false, error: { kind: "malformed" } };
  if (v !== "1") return { ok: false, error: { kind: "unsupported-version" } };

  if (stripped.includes("%"))
    return { ok: false, error: { kind: "malformed" } };

  const pieces = stripped.split("&");
  if (pieces.some((p) => p === "")) {
    return { ok: false, error: { kind: "malformed" } };
  }

  const piecesMap = new Map<string, string>();
  for (const p of pieces) {
    if (!p.includes("=")) return { ok: false, error: { kind: "malformed" } };
    const key = p.slice(0, p.indexOf("="));
    const value = p.slice(p.indexOf("=") + 1);

    if (!key || key === "") {
      return { ok: false, error: { kind: "malformed" } };
    }

    if (piecesMap.get(key) !== undefined) {
      return { ok: false, error: { kind: "malformed" } };
    }

    piecesMap.set(key, value);
  }

  const keys = piecesMap.keys();
  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      return { ok: false, error: { kind: "malformed" } };
    }
  }

  const a = piecesMap.get("a");
  const t = piecesMap.get("t");
  const k = piecesMap.get("k");
  if (!a || !t) return { ok: false, error: { kind: "malformed" } };

  try {
    const decodedA = decodeBase64url(a, 16);
    decodeBase64url(t, 32);
    return piecesMap.has("k")
      ? {
          ok: true,
          invite: {
            mode: "qr",
            albumId: decodedA,
            token: t,
            key: decodeBase64url(piecesMap.get("k")!, 32),
          },
        }
      : {
          ok: true,
          invite: { mode: "passphrase", albumId: decodedA, token: t },
        };
  } catch (error) {
    return { ok: false, error: { kind: "malformed" } };
  }
};
