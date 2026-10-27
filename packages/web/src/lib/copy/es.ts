/*
 * Spanish copy (Spain, tú throughout), slot for slot with en.ts. Each slot's
 * rule is written above it in en.ts and binds this text equally: translate
 * the meaning and its limits, never the words alone, and never into something
 * stronger because it reads more naturally. Brief §3's never-claim list holds
 * here in its Spanish forms (es.test.ts), and api-sketch §11.6's log
 * vocabulary is abrir: abrió, never vio or visitó.
 *
 * `Copy` makes a missing or extra slot a type error, so no screen can fall
 * back to English silently.
 *
 * `onboarding.text` is brief §16's Spanish reference text, signed off by the
 * owner on 26 October 2026 (brief §15.3). It is not edited here.
 */
import type { Copy } from "./en";
import { intlFormat, number, plural, type Format } from "./format";

const L = "es-ES";
const n_ = (n: number): string => number(L, n);

export const es: Copy = {
  /** Brief §16, Spanish reference text. Its third paragraph is the house-key presentation. */
  "onboarding.text": [
    "Alguien ha abierto una ventana para compartir algo contigo: tienes acceso a un álbum que ha elegido para ti, y puedes visitarlo tantas veces como quieras.",
    "No se guarda nada automáticamente en tu móvil ni en tu ordenador. No hay ningún archivo que reenviar. Nuestros servidores no pueden leer las fotos.",
    "El enlace es la llave: no lo compartas con nadie. Las capturas de pantalla llevan una marca y todas las invitaciones se pueden revocar.",
  ],
  "onboarding.continue": "Abrir el álbum",

  "open.loading": "Abriendo el álbum…",
  "open.newer-version":
    "Esta invitación se hizo para una versión más reciente de esta aplicación, así que aquí no se puede abrir. Pregunta a la persona que te la envió.",

  "derive.wait":
    "Desbloqueando en este dispositivo. Puede tardar unos segundos.",
  "derive.failed":
    "Este dispositivo no ha podido terminar de abrir el álbum. Vuelve a abrir el enlace de tu invitación para intentarlo otra vez, o usa otro móvil u ordenador.",

  "recipient.passphrase.title": "Escribe tu frase de contraseña",
  "recipient.passphrase.label":
    "La persona que te ha invitado te ha dado unas palabras que van con este enlace. Escríbelas en orden.",
  "recipient.passphrase.word": (n: number) => `Palabra ${n_(n)}`,
  "recipient.passphrase.submit": "Abrir el álbum",
  "pass.entry": "Las mayúsculas y las tildes dan igual.",
  "pass.empty": "Escribe primero las palabras de tu frase de contraseña.",
  "pass.wrong":
    "Esas palabras no abren este álbum. Revisa cada palabra y vuelve a intentarlo.",
  "pass.lost":
    "¿Has perdido la frase de contraseña? Nadie puede recuperarla, pero la persona que te ha invitado puede enviarte una invitación nueva.",

  "grid.empty":
    "Todavía no hay fotos aquí. Vuelve a abrir el enlace de tu invitación más tarde para comprobarlo.",
  "grid.photo.a11y": (i: number, n: number) =>
    `Foto ${n_(i)} de ${n_(n)}. Se abre en grande.`,
  "grid.cell.loading.a11y": (i: number, n: number) =>
    `Foto ${n_(i)} de ${n_(n)}, cargando`,
  "grid.cell.failed": "No se ha podido cargar. Toca para volver a intentarlo.",
  "grid.cell.unavailable": "Esta foto no se puede mostrar.",

  watermark: (label: string, date: string) => `${label} · ${date}`,

  "viewer.back": "Volver al álbum",
  "viewer.back-to-album": "Volver al álbum",
  "viewer.photo.a11y": (i: number, n: number) => `Foto ${n_(i)} de ${n_(n)}`,
  "viewer.loading": "Cargando la foto completa…",
  "viewer.zoom-in": "Ampliar",
  "viewer.zoom-out": "Reducir",
  "viewer.pan-up": "Mover arriba",
  "viewer.pan-down": "Mover abajo",
  "viewer.pan-left": "Mover a la izquierda",
  "viewer.pan-right": "Mover a la derecha",
  "viewer.fit": "Ajustar",
  "viewer.removed": "Esta foto ya no está en este álbum.",
  "viewer.failed": "Esta foto no se ha podido mostrar en este dispositivo.",

  revoked:
    "Este álbum ya no se comparte contigo. La persona que te invitó puede darte más detalles.",
  notrecognised:
    "Esta invitación no funciona. Pide a la persona que te la envió que la revise o que te envíe una nueva.",
  dead: "Vuelve a abrir el enlace de tu invitación para ver el álbum.",

  offline:
    "Ahora mismo no se puede acceder al álbum. Comprueba tu conexión y vuelve a intentarlo.",
  "offline.retry": "Volver a intentarlo",

  // ── Owner path (flows §3) ─────────────────────────────────────────────────

  "derive.failed.owner":
    "Este dispositivo no ha podido terminar de desbloquear. Recarga la página para volver a intentarlo, o usa otro móvil u ordenador.",
  "derive.failed.retry": "Recargar y volver a intentarlo",

  "owner.checking": "Comprobando este dispositivo…",
  "offline.owner":
    "Ahora mismo no se puede acceder a Vitrina. Comprueba tu conexión y vuelve a intentarlo.",
  "wait.rate-limited": "Esperando un momento antes de volver a intentarlo.",
  "credential.paused": (when: string) =>
    `Esta red tiene que esperar un poco antes de volver a iniciar sesión o registrarse. Podrás volver a intentarlo dentro de ${when}.`,
  "password.show": "Mostrar contraseña",
  "password.hide": "Ocultar contraseña",

  "unlock.prompt": "Desbloquear",
  "unlock.password.label": "Contraseña",
  "unlock.submit": "Desbloquear",
  "unlock.empty": "Escribe primero tu contraseña.",
  "unlock.wrong":
    "Esa contraseña no desbloquea esta cuenta. Revísala y vuelve a intentarlo.",
  "unlock.unavailable":
    "Este dispositivo no ha podido obtener lo que necesita para desbloquear. Vuelve a intentarlo en un momento.",
  "unlock.retry": "Volver a intentarlo",
  "unlock.signout": "Cerrar sesión",
  "unlock.signout.confirm": "¿Cerrar sesión en este dispositivo?",
  "unlock.signout.consequence":
    "Para volver, tendrás que iniciar sesión con tu correo electrónico y tu contraseña.",
  "unlock.signout.yes": "Cerrar sesión",
  "unlock.signout.no": "Cancelar",

  "signin.title": "Iniciar sesión",
  "signin.email.label": "Correo electrónico",
  "signin.password.label": "Contraseña",
  "signin.submit": "Iniciar sesión",
  "signin.busy": "Iniciando sesión…",
  "signin.failed":
    "El correo electrónico o la contraseña no son correctos. Revisa los dos y vuelve a intentarlo.",
  "signin.unavailable":
    "El inicio de sesión no funciona ahora mismo. Vuelve a intentarlo en un momento.",
  "signin.retry": "Volver a intentarlo",
  "signin.cannot-unlock":
    "Tu contraseña se ha aceptado, pero los álbumes de esta cuenta no se han podido abrir en este dispositivo.",
  "signin.back": "Volver al inicio de sesión",
  "signin.to-signup": "¿Primera vez aquí? Crea una cuenta",
  "session.ended":
    "Tu sesión ha terminado y se ha cerrado. Vuelve a iniciar sesión para seguir.",
  "signed-out": "Has cerrado sesión en este dispositivo.",

  "signup.title": "Crea tu cuenta",
  "signup.email.label": "Correo electrónico",
  "signup.password.label": "Elige una contraseña",
  "signup.policy":
    "Al menos 12 caracteres, los que quieras. Unas cuantas palabras seguidas funcionan bien. No se aceptan contraseñas muy comunes.",
  "signup.too-short": "Usa al menos 12 caracteres.",
  "signup.too-long": "Usa 256 caracteres como máximo.",
  "signup.common": "Esa contraseña es demasiado común. Elige otra.",
  "signup.invalid":
    "Esa contraseña tiene un carácter que esta aplicación no puede usar. Vuelve a escribirla.",
  "signup.loss":
    "Si olvidas esta contraseña, pierdes todos los álbumes de esta cuenta. No hay forma de restablecerla y nadie puede recuperarlos, ni siquiera nosotros.",
  "signup.submit": "Crear cuenta",
  "signup.busy": "Creando tu cuenta…",
  "signup.taken":
    "Ya hay una cuenta con este correo electrónico. Si es tuya, inicia sesión.",
  "signup.taken.signin": "Iniciar sesión",
  "signup.uncertain":
    "No hemos podido saber si se ha creado tu cuenta. Inicia sesión con el mismo correo electrónico y la misma contraseña para comprobarlo.",
  "signup.uncertain.signin": "Iniciar sesión",
  "signup.failed":
    "No se ha podido crear tu cuenta. Vuelve a intentarlo más tarde.",
  "signup.to-signin": "¿Ya tienes cuenta? Inicia sesión",

  "albums.title": "Tus álbumes",
  "albums.loading": "Abriendo tus álbumes…",
  "albums.empty": "Todavía no tienes álbumes.",
  "albums.count": (n: number) =>
    plural(L, n, {
      one: (k) => `${k} elemento`,
      other: (k) => `${k} elementos`,
    }),
  "albums.failed.key": "Este álbum no se ha podido abrir en este dispositivo.",
  "albums.failed.title":
    "El nombre de este álbum no se ha podido leer en este dispositivo.",

  "album.create": "Álbum nuevo",
  "album.title.label": "Nombre del álbum",
  "album.title": "Nuestros servidores no pueden leer este nombre.",
  "album.title.empty": "Ponle un nombre al álbum.",
  "album.title.too-long": "Usa 200 caracteres como máximo.",
  "album.create.submit": "Crear álbum",
  "album.create.cancel": "Cancelar",
  "album.create.busy": "Creando el álbum…",
  "album.create.failed": "No se ha podido crear el álbum. Vuelve a intentarlo.",

  "albums.open.a11y": (title: string) => `Abrir ${title}`,
  "albums.open.untitled.a11y": "Abrir este álbum",

  // ── The owner's album (flows §3.4, §3.6, §3.7) ────────────────────────────

  "album.loading": "Abriendo el álbum…",
  "album.back": "Volver a tus álbumes",
  "album.empty": "Todavía no hay fotos en este álbum.",
  "album.add": "Añadir fotos",
  "upload.stripped":
    "La ubicación y los datos de la cámara se eliminan en este dispositivo antes de enviar nada.",
  "upload.downscale":
    "De cada foto se envía una copia de tamaño adecuado para verla en pantalla, no el archivo original.",
  "album.photo.a11y": (i: number, n: number) =>
    `Foto ${n_(i)} de ${n_(n)}. Se abre en grande.`,

  "upload.review.title": (n: number) =>
    plural(L, n, {
      one: (k) => `${k} foto elegida`,
      other: (k) => `${k} fotos elegidas`,
    }),
  "upload.review.intro":
    "No se envía nada hasta que pulses Enviar. Descarta cualquier foto que no quisieras elegir.",
  "upload.review.preview.a11y": (name: string) => `Vista previa de ${name}`,
  "upload.review.preview.loading.a11y": (name: string) =>
    `Vista previa de ${name}, cargando`,
  "upload.review.preview.failed": "Sin vista previa en este dispositivo",
  "upload.review.unreadable":
    "Esta foto no se ha podido leer. Vuelve a elegirla.",
  "upload.too-large":
    "Esas fotos son demasiado grandes para añadirlas juntas. Elige menos fotos cada vez.",
  "upload.review.caption.label": "Pie de foto (opcional)",
  "upload.review.caption.hint":
    "Se muestra debajo de la foto. Nuestros servidores no pueden leerlo.",
  "upload.review.caption.count": (n: number) =>
    `${n_(n)} de ${n_(280)} caracteres`,
  "upload.review.caption.too-long": "Usa 280 caracteres como máximo.",
  "upload.review.caption.invalid":
    "Este pie de foto tiene un carácter que no se puede guardar. Prueba a escribirlo otra vez.",
  "upload.review.remove": "Descartar",
  "upload.review.remove.a11y": (name: string) => `Descartar ${name}`,
  "upload.review.send": (n: number) =>
    plural(L, n, {
      one: (k) => `Enviar ${k} foto`,
      other: (k) => `Enviar ${k} fotos`,
    }),
  "upload.review.cancel": "Cancelar",

  "upload.queued": "Esperando su turno",
  "upload.preparing": "Preparando en este dispositivo…",
  "upload.encrypting": "Cifrando…",
  "upload.uploading": "Enviando…",
  "upload.waiting": "Esperando a que el servidor lo confirme…",

  "media.pending": "Empezada, todavía sin terminar",
  "media.processing": "Todavía está llegando",
  "upload.failed":
    "Esta foto no ha terminado de subirse. Vuelve a enviarla o quítala.",
  "upload.failed.gone":
    "Esta foto no ha terminado de subirse. Quítala y vuelve a añadirla.",
  "upload.stalled": (howLong: string, since: string) =>
    `Esta foto lleva ${howLong} atascada (desde ${since}). Puedes quitarla.`,
  "upload.resend": "Volver a enviar",

  "upload.not-stripped":
    "Esta foto no se ha enviado: este dispositivo no ha podido confirmar que se eliminaran su ubicación y los datos de la cámara.",
  "upload.not-prepared":
    "Esta foto no se ha podido preparar en este dispositivo, así que no se ha enviado nada.",
  "upload.refused":
    "El servidor no ha aceptado esta foto, así que no se ha guardado nada.",
  "upload.dismiss": "Cerrar",

  "album.leaving":
    "Todavía se está añadiendo una foto. Si sales ahora, se detiene, y lo que ya se haya enviado aparecerá aquí como sin terminar.",
  "album.leaving.go": "Salir de todos modos",
  "album.leaving.stay": "Quedarme",

  "media.remove": "Quitar",
  "remove.title": "¿Quitar esta foto?",
  "remove.checking": "Comprobando cuándo se abrió este álbum por última vez…",
  "remove.never-ready":
    "Nunca terminó de subirse, así que nadie ha podido abrirla.",
  "remove.unopened": "Nadie ha abierto este álbum desde que la añadiste.",
  "remove.opened": "Al quitarla, nadie podrá abrirla a partir de ahora.",
  "remove.confirm": "Quitar",
  "remove.cancel": "Conservarla",
  "remove.busy": "Quitando…",
  "remove.pending": (n: number) =>
    plural(L, n, {
      one: () =>
        "Una foto que has quitado ya está oculta para todos. Su copia guardada todavía no se ha borrado.",
      other: (k) =>
        `${k} fotos que has quitado ya están ocultas para todos. Sus copias guardadas todavía no se han borrado.`,
    }),

  "logout.device": "Cerrar sesión en este dispositivo",
  "logout.everywhere":
    "Cerrar sesión en todas partes, también en este dispositivo",
  "logout.busy": "Cerrando sesión…",
  "logout.partial": (everywhere: boolean) =>
    everywhere
      ? "Las claves de tus álbumes ya no están en este dispositivo, pero no se ha podido avisar al servidor para que cierre tus sesiones. Siguen siendo válidas hasta que caduquen, en este dispositivo y en cualquier otro."
      : "Las claves de tus álbumes ya no están en este dispositivo, pero no se ha podido avisar al servidor para que cierre esta sesión. Sigue siendo válida hasta que caduque.",
  "logout.retry": "Volver a intentarlo",
  "logout.leave": "Salir de todos modos",

  "session.ending": (when: string) =>
    `Tu sesión termina: ${when}. Lo que todavía se esté subiendo en ese momento se perderá.`,

  // ── Invites (flows §3.8) ──────────────────────────────────────────────────

  "album.invite": "Invitar a alguien",
  "album.people": "Personas invitadas",

  "invite.title": "Invitar a alguien a este álbum",
  "invite.back": "Volver al álbum",
  "invite.name.label": "Nombre de la persona",
  "invite.name.hint": (example: string) =>
    `Aparece en una esquina de cada foto que abra, con la fecha, así: ${example}. Nuestros servidores no pueden leerlo.`,
  "invite.name.empty": "Escribe primero el nombre.",
  "invite.name.too-long": "Usa 60 caracteres como máximo.",
  "invite.mode": "¿Cómo vas a darle la invitación?",
  "invite.mode.qr": "Un código QR o un enlace",
  "invite.mode.qr.detail":
    "Un solo enlace o código QR. Quien lo tenga puede abrir el álbum.",
  "invite.mode.passphrase": "Un enlace y una frase de contraseña",
  "invite.mode.passphrase.detail":
    "Un enlace y cinco palabras que envías por separado. El enlace solo no basta para abrirlo.",
  "invite.language": "Idioma de la frase de contraseña",
  "invite.language.hint":
    "Elige un idioma que hable esa persona, para que le resulte fácil decir y escribir las palabras. No tiene por qué ser el idioma en el que usas la aplicación.",
  "invite.language.loading": "Cargando las listas de palabras…",
  "invite.language.failed":
    "No se han podido cargar las listas de palabras. Comprueba tu conexión y vuelve a intentarlo.",
  "invite.language.retry": "Volver a intentarlo",
  "invite.language.none":
    "Las invitaciones con frase de contraseña no están disponibles en esta versión de la aplicación. Usa un código QR o un enlace.",
  "invite.language.choose":
    "Elige primero un idioma para la frase de contraseña.",
  "invite.create": "Crear la invitación",
  "invite.creating": "Creando la invitación…",
  "invite.failed":
    "No se ha podido crear la invitación y no se ha compartido nada. Vuelve a intentarlo.",
  "invite.device":
    "Este dispositivo no ha podido terminar de crear la invitación y no se ha compartido nada. Recarga la página para volver a intentarlo, o usa otro móvil u ordenador.",

  "invite.share.title": (label: string) => `Invitación para ${label}`,
  "invite.qr.a11y": (label: string) =>
    `Código QR del enlace de la invitación para ${label}`,
  "invite.housekey":
    "Este código QR y su enlace son como la llave de casa. Cualquiera que tenga uno de los dos, incluso una foto del código, puede abrir este álbum hasta que revoques la invitación.",
  "invite.housekey.passphrase":
    "Este enlace y la frase de contraseña, juntos, son como la llave de casa. Cualquiera que tenga los dos puede abrir este álbum hasta que revoques la invitación.",
  "invite.once":
    "Esta invitación no se puede volver a mostrar. Si sales antes de enviarla, tendrás que crear una nueva.",
  "invite.link.label": "El enlace",
  "invite.link.copy": "Copiar el enlace",
  "invite.link.copied": "Enlace copiado.",
  "invite.link.copy-failed":
    "No se ha podido copiar el enlace. Selecciónalo arriba y cópialo tú.",
  "invite.link.share": "Enviar el enlace…",
  "invite.channels":
    "Envía el enlace y la frase de contraseña por separado: por ejemplo, el enlace en un mensaje y las palabras por teléfono o en papel.",
  "invite.passphrase.label": "La frase de contraseña",
  "invite.passphrase.language": (language: string) => `Palabras en ${language}`,
  "invite.done": "Listo",
  "invite.leave.title": "¿Salir de esta invitación?",
  "invite.leave.consequence":
    "Cuando salgas, esta invitación no se podrá volver a mostrar. Si no la has enviado, necesitarás una nueva. Si puede que haya llegado a quien no debía, revócala desde Personas invitadas.",
  "invite.leave.stay": "Quedarme aquí",
  "invite.leave.confirm": "Salir",

  // ── Invited people and revoke (flows §3.9) ────────────────────────────────

  "people.title": "Personas invitadas",
  "people.back": "Volver al álbum",
  "people.loading": "Cargando…",
  "people.empty": "Todavía no has invitado a nadie a este álbum.",
  "people.unreadable": "Un nombre que no se puede leer en este dispositivo",
  "people.revoked": (when: string) => `Invitación revocada: ${when}`,
  "people.revoke": "Revocar",
  "people.refreshed":
    "Esta lista no estaba al día, así que se ha vuelto a cargar. Revísala antes de revocar ninguna invitación.",
  "people.log": "Registro de accesos",
  "people.log.person": (label: string) => `Lo que ha abierto ${label}`,
  "people.log.person.unnamed": "Lo que ha abierto",

  "revoke.confirm.title": (label: string) =>
    `¿Revocar la invitación de ${label}?`,
  "revoke.confirm.title.unnamed": "¿Revocar esta invitación?",
  "revoke.confirm": (label: string) =>
    `A partir de ahora, ${label} no podrá abrir el álbum.`,
  "revoke.confirm.unnamed":
    "A partir de ahora, esa persona no podrá abrir el álbum.",
  "revoke.yes": "Revocar",
  "revoke.no": "Conservarla",
  "revoke.busy": "Revocando…",
  "revoke.done":
    "Revocada. Esa invitación no abre nada a partir de ahora. Para que vuelva a entrar, crea una invitación nueva.",
  "revoke.failed":
    "No se ha podido revocar esta invitación. Vuelve a intentarlo.",

  // ── Access log (flows §3.10, api-sketch §11.6) ────────────────────────────
  // abrir and nothing else: abrió, ha abierto. Never ver, visitar or mirar.

  "log.summary.opens": (n: number) =>
    n === 0
      ? "Todavía no ha abierto este álbum"
      : plural(L, n, {
          one: () => "Ha abierto este álbum una vez",
          other: (k) => `Ha abierto este álbum ${k} veces`,
        }),
  "log.summary.photos": (n: number) =>
    plural(L, n, {
      one: (k) => `Ha abierto ${k} foto`,
      other: (k) => `Ha abierto ${k} fotos`,
    }),
  "log.summary.last": (when: string) => `Lo abrió por última vez el ${when}`,
  "log.sparse":
    "Esto muestra lo que ha abierto cada persona, no lo que puede abrir: todas las personas de esta lista que no estén revocadas pueden abrir todas las fotos de este álbum.",
  "log.counts":
    "Cada vez que se abre el álbum o una foto cuenta una vez, también al recargar.",

  "log.title": "Registro de accesos",
  "log.title.person": (label: string) => `Lo que ha abierto ${label}`,
  "log.title.person.unnamed": "Lo que ha abierto",
  "log.back": "Volver a personas invitadas",
  "log.loading": "Cargando el registro…",
  "log.none": "Nadie ha abierto este álbum todavía.",
  "log.none.person": "Todavía no ha abierto este álbum.",
  "log.entry.album": (label: string) => `${label} abrió este álbum`,
  "log.entry.photo": (label: string) => `${label} abrió esta foto`,
  "log.entry.album.unnamed":
    "Alguien cuyo nombre no se puede leer abrió este álbum",
  "log.entry.photo.unnamed":
    "Alguien cuyo nombre no se puede leer abrió esta foto",
  "log.photo.removed":
    "Una foto que has quitado. Ya está oculta para todos, y sus entradas desaparecen cuando se borre su copia guardada.",
  "log.photo.failed": "Esta foto no se ha podido mostrar.",
  "log.photo.loading.a11y": "Foto cargando",
  "log.photo.a11y": "La foto que se abrió",
  "log.more": "Mostrar entradas anteriores",
  "log.more.busy": "Cargando entradas anteriores…",

  // ── The interface language ────────────────────────────────────────────────

  "language.label": "Idioma",

  // ── Licences ──────────────────────────────────────────────────────────────
  // Licence names stay as their authors publish them.

  "licences.link": "Licencias",
  "licences.title": "Licencias",
  "licences.intro":
    "Vitrina incluye trabajo de otras personas, usado con estas licencias. Cada enlace abre el texto de la licencia.",
  "licences.font":
    "La fuente Atkinson Hyperlegible — SIL Open Font License 1.1",
  "licences.wordlist.en":
    "Las palabras de las frases de contraseña en inglés (EFF Large Wordlist) — CC BY 4.0",
  "licences.wordlist.es":
    "Las palabras de las frases de contraseña en español, una selección hecha a partir de las frecuencias de palabras de OpenSubtitles, Wiktionary y los treebanks en español de Universal Dependencies — CC BY-SA 4.0",
  "licences.blocklist":
    "Las contraseñas muy comunes que se rechazan al registrarse (SecLists) — MIT License",
  "licences.back": "Volver a Vitrina",
};

export const esFormat: Format = {
  ...intlFormat(L),
  /** "unos 3 minutos", "alrededor de un día". */
  stuckFor(ms) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60)
      return plural(L, minutes, {
        one: () => "alrededor de un minuto",
        other: (k) => `unos ${k} minutos`,
      });
    const hours = Math.round(minutes / 60);
    if (hours < 24)
      return plural(L, hours, {
        one: () => "alrededor de una hora",
        other: (k) => `unas ${k} horas`,
      });
    return plural(L, Math.round(hours / 24), {
      one: () => "alrededor de un día",
      other: (k) => `unos ${k} días`,
    });
  },
  /** "unos 12 minutos", "45 segundos". */
  pauseLeft(ms) {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    if (seconds < 60)
      return plural(L, seconds, {
        one: (k) => `${k} segundo`,
        other: (k) => `${k} segundos`,
      });
    return plural(L, Math.ceil(seconds / 60), {
      one: (k) => `alrededor de ${k} minuto`,
      other: (k) => `unos ${k} minutos`,
    });
  },
};
