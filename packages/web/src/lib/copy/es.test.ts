/*
 * The Spanish copy against the rules en.test.ts holds the English to, in their
 * Spanish forms, and against the two settled for Spanish alone: tú throughout,
 * and brief §16's text exactly as the owner signed it off (brief §15.3).
 */
import { describe, expect, it } from "vitest";
import { WATERMARK_EXAMPLE, en } from "./en";
import { PASSPHRASE_WORDS } from "$lib/keys/owner-open";
import { es, esFormat } from "./es";

function strings(): [string, string][] {
  const out: [string, string][] = [];
  for (const [slot, value] of Object.entries(es)) {
    if (typeof value === "string") out.push([slot, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => out.push([`${slot}[${i}]`, String(v)]));
    else if (typeof value === "function") {
      const f = value as (...a: unknown[]) => unknown;
      for (const args of [[1], [3], [true], [false], ["María", "6 ago 2026"], ["jue, 29 oct, 12:00"]]) {
        let r: unknown;
        try {
          r = f(...args);
        } catch (e) {
          if (e instanceof TypeError) continue; // a count slot refuses a non-number (format.ts plural)
          throw e;
        }
        for (const s of Array.isArray(r) ? r : [r]) out.push([slot, String(s)]);
      }
    }
  }
  return out;
}

const kind = (v: unknown): string => (Array.isArray(v) ? `list of ${v.length}` : typeof v === "function" ? `function of ${v.length}` : typeof v);

describe("es has exactly en's slots (no screen falls back to English)", () => {
  it("the same keys, no more and no fewer", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it("each slot of the same kind: a string, a list of the same length, or a function of the same arity", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(kind(es[k]), k).toBe(kind(en[k]));
  });

  it("no slot is left in English", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      if (k === "watermark") continue; // name · date: the same shape in every language
      const a = typeof en[k] === "function" ? (en[k] as (...x: unknown[]) => unknown)(3, 3) : en[k];
      const b = typeof es[k] === "function" ? (es[k] as (...x: unknown[]) => unknown)(3, 3) : es[k];
      expect(b, k).not.toEqual(a);
    }
  });
});

/** Brief §16 in Spanish, as signed off by the owner on 27 October 2026, recorded in the brief. An edit here is an edit to the reference text. */
const SIGNED_OFF_16 = [
  "Alguien ha abierto una ventana para compartir algo contigo: tienes acceso a un álbum que ha elegido para ti, y puedes visitarlo tantas veces como quieras.",
  "No se guarda nada automáticamente en tu móvil ni en tu ordenador. No hay ningún archivo que reenviar. Nuestros servidores no pueden leer las fotos.",
  "El enlace es la llave: no lo compartas con nadie. Las capturas de pantalla llevan una marca y todas las invitaciones se pueden revocar.",
];

describe("brief §16 (brief §15.3: the guarantee and its limit both survive)", () => {
  it("is the signed-off text, verbatim", () => {
    expect(es["onboarding.text"]).toEqual(SIGNED_OFF_16);
  });

  it("the link is the llave, never the clave (which would read as 'what matters')", () => {
    expect(es["onboarding.text"][2]).toMatch(/^El enlace es la llave: /);
    expect(es["onboarding.text"].join(" ")).not.toMatch(/\bclave\b/i);
  });

  it("nothing is saved automatically, on the recipient's own device: not 'nothing can be saved'", () => {
    expect(es["onboarding.text"][1]).toMatch(/automáticamente en tu /);
    expect(es["onboarding.text"][1]).not.toMatch(/no se puede (guardar|descargar)|no se descarga/i);
  });

  it("screenshots carry a mark, never a trace, and are never qualified as shared", () => {
    expect(es["onboarding.text"][2]).toMatch(/capturas de pantalla llevan una marca/);
    expect(es["onboarding.text"].join(" ")).not.toMatch(/rastro|huella|detect|compartidas/i);
  });
});

const NEVER_ANYWHERE: [RegExp, string][] = [
  [
    /(bloque|impid|imped|evit)\w* (hacer )?(las |que se hagan )?capturas|capturas?( de pantalla)? (están |quedan |son )?(bloquead|imposible|impedid|prohibid)|imposible (hacer )?capturas/i,
    "brief §3: screenshots are never prevented",
  ],
  [/\bDRM\b|incopiable|anticopia|imposible (de )?copiar|no se pued(e|en) copiar|no se pueden? descargar/i, "brief §3: never uncopyable or DRM"],
  [/\bsegur[oa]s?\b|\bseguridad\b|\bprotegid[oa]s?\b|\bproteg(e|en|er)\b|a salvo|privad[oa]s? para siempre/i, "brief §3: no protection claims"],
  [/(borr|elimin)\w* .*contraseña|contraseña.*\b(se borra|se elimina|borrada|eliminada|olvidada por)\b/i, "api-sketch §8.4: the password cannot be erased"],
];

const OWNER_ATTEMPTS = /\bintentos?\b|\bquedan?\b|\bbloquead[oa]s?\b|\bse bloquear|\bdemasiad[oa]s (veces|intentos)\b/i;

describe("the Spanish copy", () => {
  for (const [pattern, rule] of NEVER_ANYWHERE) {
    it(`never: ${rule}`, () => {
      expect(strings().filter(([, s]) => pattern.test(s))).toEqual([]);
    });
  }

  it("the never-claim patterns catch the forms a natural translation reaches for", () => {
    const bad = [
      "Tus fotos están protegidas.",
      "Un álbum seguro.",
      "Privado para siempre.",
      "Vitrina bloquea las capturas de pantalla.",
      "Las capturas de pantalla están bloqueadas.",
      "Es imposible copiar las fotos.",
      "Las fotos no se pueden copiar.",
      "Las fotos no se pueden descargar.",
    ];
    for (const s of bad) expect(NEVER_ANYWHERE.some(([p]) => p.test(s)), s).toBe(true);
  });

  /*
   * An usted imperative is spelt like a third-person subjunctive ("que la
   * revise" is correct tú copy), so the plain forms count only where a command
   * stands: at the start of a sentence or clause. Forms with an
   * attached pronoun ("Inténtelo") are usted wherever they are.
   */
  const USTED =
    /\busted(es)?\b|(^|[.:,!?¿¡]\s+)(escriba|revise|vuelva|compruebe|elija|use|pulse|toque|intente|recargue|envíe|quite|inicie|cree|añada|pruebe|descarte|pregunte|pida|cierre|abra|espere|ponga|copie|seleccione|revoque)\b|\b(inténtelo|escríbalas?|revísel[oa]s?|quítel[oa]s?|cópielo|selecciónelo|revóquel[oa]|póngale|elíjala)\b/i;

  it("is tú throughout: no usted, and no usted imperative", () => {
    expect(strings().filter(([, s]) => USTED.test(s))).toEqual([]);
  });

  it("the usted check catches usted and passes tú", () => {
    for (const s of ["Vuelva a intentarlo.", "Si es suya, inicie sesión.", "No se ha podido copiar. Selecciónelo arriba.", "¿Ha perdido la frase? Usted puede pedir otra."]) expect(USTED.test(s), s).toBe(true);
    for (const s of ["Vuelve a intentarlo.", "Pide a la persona que te la envió que la revise.", "Cada foto que abra."]) expect(USTED.test(s), s).toBe(false);
  });

  it("unlock, sign-in and the rate-limit wait never suggest that attempts are counted", () => {
    const owner = strings().filter(([slot]) => /^(unlock|signin|wait|session|signed-out|credential)/.test(slot));
    expect(owner.length).toBeGreaterThan(10);
    expect(owner.filter(([, s]) => OWNER_ATTEMPTS.test(s))).toEqual([]);
  });

  it("credential.paused names this network, never the account", () => {
    const s = es["credential.paused"](esFormat.pauseLeft(720_000));
    expect(s).toMatch(/\besta red\b/i);
    expect(s).not.toMatch(/\bcuenta\b|\btu (correo|contraseña)\b/i);
    expect(s).not.toMatch(OWNER_ATTEMPTS);
  });

  it("signup.taken does not claim that whether an account exists is private", () => {
    expect(es["signup.taken"]).not.toMatch(/privad|confidencial|secret|no (podemos|puede) (decir|saber)/i);
  });

  it("signin.failed and signin.unavailable never say which half was wrong, or that an account exists", () => {
    for (const s of [es["signin.failed"], es["signin.unavailable"]]) {
      expect(s).not.toMatch(/no (hay|existe) (ninguna )?cuenta|no (está )?registrad|contraseña (incorrecta|errónea)|correo (incorrecto|desconocido)/i);
    }
    expect(es["signin.unavailable"]).not.toBe(es["signin.failed"]);
    expect(es["signin.unavailable"]).not.toBe(es["derive.failed.owner"]);
  });

  it("signup.loss says every album is lost and nothing recovers them", () => {
    expect(es["signup.loss"]).toMatch(/todos los álbumes/i);
    expect(es["signup.loss"]).toMatch(/no hay forma de restablecer/i);
  });
});

describe("the owner's album copy, in Spanish", () => {
  const album = () => strings().filter(([slot]) => /^(album\.|upload\.|media\.|remove\.)/.test(slot));

  it("nothing says a photo is uploaded or done: only the server's ready is (api-sketch §9.7)", () => {
    expect(album().length).toBeGreaterThan(25);
    const DONE = /\b(subida|subidas|subido|completad[oa]s?|terminad[oa] de subir|listo|lista)\b/i;
    expect(album().filter(([, s]) => DONE.test(s))).toEqual([]);
  });

  it("failures give no reason (api-sketch §9.8)", () => {
    for (const s of [es["upload.failed"], es["upload.failed.gone"], es["upload.stalled"]("unas 2 horas", "14:05")]) {
      expect(s).not.toMatch(/\bporque\b|\berror\b|\balmacenamiento\b|\bred\b|\bconexión\b/i);
    }
  });

  it("remove.unopened conveys exactly the computed statement, with abrir and nothing stronger", () => {
    expect(es["remove.unopened"]).toBe("Nadie ha abierto este álbum desde que la añadiste.");
  });

  it("no removal copy says a photo was not opened: thumbnails never log", () => {
    for (const [slot, s] of album().filter(([slot]) => slot.startsWith("remove."))) {
      expect(s, slot).not.toMatch(/nadie ha (abierto|visto) (esta|la) foto|(la|esta) foto no se ha (abierto|visto)/i);
    }
  });

  it("remove.opened stops future access and never implies what was retrieved is withdrawn (brief §8)", () => {
    expect(es["remove.opened"]).toBe("Al quitarla, nadie podrá abrirla a partir de ahora.");
    expect(es["remove.opened"]).not.toMatch(/retir|recuper|borra\w* de (su|sus|todos)|desaparece de/i);
  });

  it("remove.pending never promises erasure or implies anything runs after the screen closes", () => {
    for (const n of [1, 3]) {
      const s = es["remove.pending"](n);
      expect(s).toMatch(/ocultas? para todos/i);
      expect(s).toMatch(/no se ha(n)? borrado/i);
      expect(s).not.toMatch(/en curso|se está(n)? borrando|se borrará|pronto|enseguida|automáticamente|en segundo plano|más tarde|con el tiempo|al final/i);
    }
  });

  it("upload.downscale says a viewing-size copy is sent and claims nothing about copying", () => {
    expect(es["upload.downscale"]).toMatch(/copia de tamaño adecuado para verla/i);
    expect(es["upload.downscale"]).not.toMatch(/no (se )?pued|impid|evit|copiarla/i);
  });
});

describe("the caption copy, in Spanish", () => {
  it("may say the server can't read it, and nothing stronger (brief §3)", () => {
    expect(es["upload.review.caption.hint"]).toMatch(/servidores no pueden leerlo/i);
    for (const [slot, s] of strings().filter(([slot]) => slot.startsWith("upload.review."))) {
      expect(s, slot).not.toMatch(/\b(privad|secret|segur|protegid|cifrad|nadie|solo tú|solo ell)/i);
    }
  });

  it("the review says nothing is sent until Enviar, the button's own word", () => {
    expect(es["upload.review.intro"]).toMatch(/no se envía nada hasta que pulses enviar/i);
    expect(es["upload.review.send"](2)).toMatch(/^Enviar /);
  });
});

describe("the invite copy, in Spanish", () => {
  const invite = () => strings().filter(([slot]) => slot.startsWith("invite."));

  it("neither mode is presented as stronger in every respect", () => {
    const modeCopy = strings().filter(([slot]) => slot.startsWith("invite.mode"));
    expect(modeCopy.filter(([, s]) => /recomendad|más segur|menos segur|más débil|más fuerte|\bmejor\b|\bpeor\b|lo ideal/i.test(s))).toEqual([]);
  });

  it("each mode says the practical difference, and nothing about servers or stolen data", () => {
    expect(es["invite.mode.qr.detail"]).toBe("Un solo enlace o código QR. Quien lo tenga puede abrir el álbum.");
    expect(es["invite.mode.passphrase.detail"]).toBe("Un enlace y cinco palabras que envías por separado. El enlace solo no basta para abrirlo.");
    const modeCopy = strings().filter(([slot]) => slot.startsWith("invite.mode"));
    expect(modeCopy.filter(([, s]) => /servidor|robar|roba|datos|atac|adivin/i.test(s))).toEqual([]);
  });

  it("the passphrase mode's word count is the one the invite generates", () => {
    expect(PASSPHRASE_WORDS).toBe(5);
    expect(es["invite.mode.passphrase.detail"]).toMatch(/\bcinco palabras\b/);
  });

  it("the house-key line: a llave, anyone who has it can open this album, until revoked (invite spec §3)", () => {
    for (const s of [es["invite.housekey"], es["invite.housekey.passphrase"]]) {
      expect(s).toMatch(/como la llave de casa/i);
      expect(s).toMatch(/\bcualquiera\b/i);
      expect(s).toMatch(/puede abrir este álbum/i);
      expect(s).toMatch(/hasta que revoques/i);
    }
    expect(es["invite.housekey"]).toMatch(/foto del código/i);
  });

  it("never implies the invitation cannot be passed on (brief §3, §11)", () => {
    expect(invite().filter(([, s]) => /no se puede (reenviar|compartir|pasar)|solo (tú|él|ella|esa persona) (puede|podrá)|nadie más/i.test(s))).toEqual([]);
  });

  it("the share screen says it is shown once, and the leave sheet names the remedy", () => {
    expect(es["invite.once"]).toMatch(/no se puede volver a mostrar/i);
    expect(es["invite.leave.consequence"]).toMatch(/una nueva/i);
    expect(es["invite.leave.consequence"]).toMatch(/revóca/i);
  });

  it("the passphrase language is the recipient's, not the app's (brief §15.2)", () => {
    expect(es["invite.language.hint"]).toMatch(/que hable esa persona/i);
    // The rule, not one wording of it: the passphrase need not be in the interface's language.
    expect(es["invite.language.hint"]).toMatch(/no tiene por qué ser (en )?el (mismo )?idioma\b[^.]*\b(aplicación|usas)\b/i);
  });

  it("the link and the passphrase go separately, and nothing offers to copy the passphrase", () => {
    expect(es["invite.channels"]).toMatch(/por separado/i);
    expect(strings().filter(([, s]) => /copiar (la )?(frase|las palabras)/i.test(s))).toEqual([]);
  });

  it("the device failure is not a wrong input, and says nothing was shared", () => {
    expect(es["invite.device"]).toMatch(/este dispositivo/i);
    expect(es["invite.device"]).toMatch(/no se ha compartido nada/i);
    expect(es["invite.failed"]).toMatch(/no se ha compartido nada/i);
  });
});

describe("the revoke copy, in Spanish (brief §8)", () => {
  it("stops access from now on, named or not, and re-inviting means a new invitation", () => {
    expect(es["revoke.confirm"]("María")).toBe("A partir de ahora, María no podrá abrir el álbum.");
    expect(es["revoke.confirm.unnamed"]).toMatch(/^A partir de ahora, /);
    expect(es["revoke.done"]).toMatch(/a partir de ahora/i);
    expect(es["revoke.done"]).toMatch(/invitación nueva/i);
  });

  it("no sentence about what was already seen, taken back or undone (owner's hand walk, 26 October 2026)", () => {
    const slots = strings().filter(([slot]) => /^(remove|revoke)\./.test(slot));
    expect(slots.filter(([, s]) => /ya (se )?haya visto|ya (ha|han) visto|deshace|deshacer|recuperar|retroactiv/i.test(s))).toEqual([]);
  });

  it("never implies that anything already seen is withdrawn, deleted or undecryptable", () => {
    const revoke = strings().filter(([slot]) => slot.startsWith("revoke."));
    expect(revoke.filter(([, s]) => /(retira|borra|elimina)\w* (de )?(su|sus|lo que)|ya no (podrá|puede) (ver|abrir) (lo que|nada de lo)|recupera/i.test(s))).toEqual([]);
  });
});

describe("the access-log copy, in Spanish (api-sketch §11.6: abrió, never vio or visitó)", () => {
  const log = () => strings().filter(([slot]) => /^(log\.|people\.)/.test(slot));

  it("uses abrir, never ver, visitar, mirar or consultar", () => {
    expect(log().length).toBeGreaterThan(20);
    const SEEN = /\b(vio|visto|vista|ve|ven|ver|viste|visitó|visitado|visita\w*|mir[óa]\w*|consult[óa]\w*|visualiz\w*)\b/i;
    expect(log().filter(([, s]) => SEEN.test(s))).toEqual([]);
    expect(SEEN.test("María vio esta foto")).toBe(true);
  });

  it("matches §11.6's permitted phrasings", () => {
    expect(es["log.summary.opens"](3)).toBe("Ha abierto este álbum 3 veces");
    expect(es["log.summary.photos"](12)).toBe("Ha abierto 12 fotos");
    expect(es["log.summary.last"]("6 ago")).toBe("Lo abrió por última vez el 6 ago");
    expect(es["log.entry.album"]("María")).toBe("María abrió este álbum");
  });

  it("a sparse log is not evidence of restricted access, and the copy says what the counts are", () => {
    expect(es["log.sparse"]).toMatch(/no lo que puede abrir/i);
    expect(es["log.sparse"]).toMatch(/todas las fotos/i);
    expect(log().filter(([, s]) => /\bsolo (ha abierto|ha podido|tiene acceso|puede)|restringid|limitad/i.test(s))).toEqual([]);
    expect(es["log.counts"]).toMatch(/recarg/i);
  });

  it("never says a photo was not opened: thumbnails never log", () => {
    expect(log().filter(([, s]) => /(no|nunca) ha abierto (esta|la|una|ninguna) foto|ninguna foto abierta|abierto 0|ha abierto ninguna/i.test(s))).toEqual([]);
  });

  it("the removed-photo state promises nothing about when erasure completes", () => {
    const s = es["log.photo.removed"];
    expect(s).toMatch(/oculta para todos/i);
    expect(s).not.toMatch(/en curso|se está borrando|pronto|enseguida|automáticamente|en segundo plano|con el tiempo/i);
  });
});

describe("dates, numbers and plurals, through Intl in Spanish", () => {
  const d = new Date(2026, 7, 6, 14, 5);
  const now = new Date(2026, 9, 26, 18, 0);

  it("the watermark's date is Spanish, and the invite's example is the watermark as drawn", () => {
    expect(esFormat.watermarkDate(d)).toBe(new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" }).format(d));
    expect(esFormat.watermarkDate(d)).toMatch(/^6 ago\.? 2026$/);
    const example = es.watermark(WATERMARK_EXAMPLE.label, esFormat.watermarkDate(WATERMARK_EXAMPLE.date));
    expect(es["invite.name.hint"](example)).toContain(`María · ${esFormat.watermarkDate(WATERMARK_EXAMPLE.date)}`);
    expect(es.watermark("María", "6 ago 2026")).not.toMatch(/rastre|seguimiento|identific|registr/i);
  });

  it("no date in a Spanish screen is written in English", () => {
    const ENGLISH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;
    for (const s of [esFormat.watermarkDate(d), esFormat.sessionEndTime(d), esFormat.logTime(d, now), esFormat.logDay(d, now), esFormat.stuckSince(d, now)]) {
      expect(s).not.toMatch(ENGLISH);
    }
    expect(esFormat.logTime(new Date(2025, 9, 15, 14, 5), now)).toMatch(/2025/);
  });

  it("plurals by Intl.PluralRules, numbers by Intl.NumberFormat", () => {
    expect(es["albums.count"](1)).toBe("1 elemento");
    expect(es["albums.count"](3)).toBe("3 elementos");
    expect(es["upload.review.send"](1)).toBe("Enviar 1 foto");
    expect(es["log.summary.opens"](1)).toBe("Ha abierto este álbum una vez");
    expect(es["log.summary.opens"](0)).toBe("Todavía no ha abierto este álbum");
    expect(es["albums.count"](12345)).toBe(`${new Intl.NumberFormat("es-ES").format(12345)} elementos`);
  });

  it("durations in words, never to zero", () => {
    expect(esFormat.stuckFor(30_000)).toBe("alrededor de un minuto");
    expect(esFormat.stuckFor(10 * 60_000)).toBe("unos 10 minutos");
    expect(esFormat.stuckFor(2 * 3600_000)).toBe("unas 2 horas");
    expect(esFormat.stuckFor(36 * 3600_000)).toBe("unos 2 días");
    expect(esFormat.pauseLeft(900_000)).toBe("unos 15 minutos");
    expect(esFormat.pauseLeft(60_000)).toBe("alrededor de 1 minuto");
    expect(esFormat.pauseLeft(0)).toBe("1 segundo");
    expect(esFormat.pauseLeft(45_000)).toBe("45 segundos");
  });

  it("names passphrase languages in Spanish", () => {
    expect(esFormat.languageName("es")).toBe("español");
    expect(esFormat.languageLabel("en")).toBe("Inglés");
    expect(es["invite.passphrase.language"](esFormat.languageName("en"))).toBe("Palabras en inglés");
  });
});
