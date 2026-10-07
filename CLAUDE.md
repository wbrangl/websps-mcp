# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Befehle

```bash
npm run build        # tsc -p tsconfig.build.json → dist/ (ohne *.test.ts)
npm run dev          # Server per tsx direkt aus src/ (stdio)
npm run typecheck
npm run lint         # biome check; npm run format behebt automatisch
npm test             # vitest run
npx vitest run src/device/crc16.test.ts      # einzelne Testdatei
npx vitest run -t "matches the CRC"          # einzelner Test nach Name
docker build -t websps-mcp:dev .             # Image (stdio-Server, STATE_DIR=/state, User node)
```

Tests liegen neben dem Code (`src/**/*.test.ts`) und brauchen kein echtes Gerät: `src/testing/fakeDevice.ts` ist
ein lokaler HTTP-Server, der wie ein Web@SPS antwortet (inkl. selbst nachgebauter „Variablen ID“-Tabelle — keine
Firmware-Inhalte ins Repo kopieren). `src/e2e.test.ts` startet den Server per `tsx` über stdio und prüft ihn mit dem
Client-SDK in **beiden** Protokoll-Eras (`{ pin: "2026-07-28" }` und `legacy`). Manueller Test: JSON-RPC-Zeilen per
Pipe an `node dist/index.js` schicken (stdout = Protokoll, Logs nach stderr).

Private Hinweise (Designunterlagen, Testgerät) stehen in `CLAUDE.local.md`.

`README.md` ist die öffentliche Kundendoku (Englisch): bei Änderungen an Tools, Profilen, Konfiguration,
Gerätemasken oder Fehlercodes mitziehen.

Dieses Repo wird unter MIT-Lizenz veröffentlicht: Keine Zugangsdaten, Kundennamen, internen IPs oder Inhalte aus
nicht öffentlichen Unterlagen in committete Dateien, Commits oder Testdaten übernehmen. Beispieladressen: die
Werksadresse `192.168.2.102` aus dem Handbuch (weitere Geräte `.103` usw.). Schreibweise immer `Web@SPS`; als
Schriftzug wie in der Geräte-Web-UI (weißes „Web@“, rotes kursives „SPS“, `docs/websps-wordmark.svg`).

## Release

Einzige Versionsquelle ist `package.json` (der Server meldet sie auch im Handshake). Ablauf:

1. `npm version <x.y.z> --no-git-tag-version`, README-Beispiele (`websps-mcp@x.y.z`, `websps-mcp:x.y.z`) anpassen.
2. `npm run typecheck && npm run lint && npm test`, committen.
3. Git-Tag `v<x.y.z>` setzen.
4. Image: `docker build --build-arg VERSION=<x.y.z> --build-arg REVISION=$(git rev-parse HEAD)
   --build-arg SOURCE=<repo-url> -t websps-mcp:<x.y.z> .` (setzt die OCI-Labels; prüfen mit
   `docker image inspect`). Basis-Image ist per Digest gepinnt (`NODE_IMAGE` im `Dockerfile`) — pro Release bewusst
   aktualisieren.
5. Dokumentierte Konfigurationen nennen immer eine feste Version, nie `:latest`.

## Worum es geht

Ein MCP-Server, über den beliebige Agenten-Plattformen (Claude, OpenAI, Hermes, OpenClaw, Ontheia, …)
Web@SPS-SPS-Geräte (IPC@CHIP, 16-Bit DOS, einfädig) über deren HTTP/JSON-API (`/api`, `/files`) steuern —
auch mehrere Geräte gleichzeitig. Kein plattformspezifischer Code im Kern.

## Stack

- TypeScript 7 (ESM, `NodeNext`, strict), Node ≥22 (Node 20 ist EOL; vitest 5 braucht ≥22), npm, `vitest`,
  `biome`; Paketname `websps-mcp`. Alle Abhängigkeiten exakt gepinnt.
- MCP-SDK: **`@modelcontextprotocol/server` v2** (exakt pinnen, Stand 2.3.0), **nicht** das alte
  `@modelcontextprotocol/sdk` 1.x (kennt die Revision 2026-07-28 nicht). v2 bedient über `serveStdio(factory)`
  bzw. `createMcpHandler` neue Clients (2026-07-28, zustandslos) und per Standard (`legacy: 'serve'`) auch ältere
  Clients mit `initialize`-Handshake (2025-11-25 bis 2024-10-07) aus derselben Server-Factory.
  Erfordert `zod` ^4.2 und in `tsconfig.json` `"types": ["node"]`.
- Erster Release: nur stdio. Remote-HTTP kommt später, der Kern muss es aber ohne Umbau erlauben.

## Architektur

Umgesetzt: alle 23 Tools (Profile read 11 · operate 13 · develop 21 · admin 23), `STATE_DIR` mit Audit-Log und
Backups und Aufbewahrung, Sperrdatei pro Gerät, Docker-Image, Kunden-README. Noch offen: Remote-HTTP-Adapter,
Veröffentlichung (npm, Image-Registry, GitHub).

- **Transportfreier Kern.** `src/index.ts` (stdio-Adapter: Config laden, `serveStdio`) → `src/server.ts`
  (`createServer(app)`, auch für einen späteren HTTP-Adapter). Die SDK-Factory kann pro Verbindung/Era mehrfach
  aufgerufen werden — Gerätezustand (Queue, Circuit Breaker, Caches) lebt deshalb in `DeviceRegistry`
  (`src/device/registry.ts`) außerhalb der Factory und wird über `app` geteilt.
- **Tools** (`src/tools/`): je Tool eine `ToolDefinition` mit Mindestprofil; `tools/index.ts` registriert nur die
  für das Profil sichtbaren, nach Namen sortiert. `handler()` in `tools/common.ts` erzeugt Text-JSON +
  `structuredContent` und wandelt `WebspsError` in `isError` mit `{code, name, message, hint, device}`.
- **Fehlercodes** (`src/errors.ts`): Gerätecodes 1–99 unverändert, eigene Server-Codes ab 1000 (`CIRCUIT_OPEN`,
  `AUTH_BLOCKED`, `UNREACHABLE`, `TIMEOUT`, `BAD_RESPONSE`, `UNKNOWN_DEVICE`, `INVALID_INPUT`). Hints auf Englisch;
  `message` ist bei Gerätefehlern der (deutsche) Gerätetext.
- **Konfiguration auf zwei Wegen**, beide gleichwertig unterstützt:
  - JSON-Datei (Pfad per `--config` oder `WEBSPS_CONFIG`) mit `devices[]` (`alias`, `url`, `auth.user`,
    `auth.password_env` / `auth.password_file`, `timeout_ms`, `timeouts_ms` pro Methode) — für mehrere Geräte.
  - Kurzform nur über Umgebungsvariablen für genau ein Gerät (`WEBSPS_URL`, `WEBSPS_USER`, `WEBSPS_PASSWORD`,
    `WEBSPS_PROFILE`) — für den üblichen `npx`-Eintrag mit `env` in der Client-Konfiguration.
  Jedes Tool hat den optionalen Parameter `device` (im Schema als `enum` der Aliase; Pflicht bei >1 Gerät). Keine
  plattformspezifische Secret-Syntax, kein Klartext-Passwort in der Datei. `WEBSPS_PROFILE` überschreibt das
  `profile` der Datei; Standardprofil ist `read`. Dasselbe Gerät (Host) darf nur einmal konfiguriert sein — die
  IP-Sperre gilt pro anfragender IP, nicht pro Benutzer, und zwei Queues würden die Serialisierung aushebeln.
- **Geräte-Client** (`src/device/client.ts`): eine Promise-Queue pro Gerät (Gerät ist einfädig); jeder Job hält
  zusätzlich `STATE_DIR/<alias>/device.lock` (`src/device/lock.ts`, atomares `mkdir`; der Halter erneuert alle
  10 s per Heartbeat den Zeitstempel, ohne Heartbeat gilt die Sperre nach 30 s als verwaist; bewusst **keine**
  PID-/Hostname-Prüfung, die zwischen Containern nicht vergleichbar ist) gegen parallele stdio-Prozesse. Code `5` BUSY → bis zu 3 Wiederholungen mit Backoff.
  Body-Limit 8192 Byte wird vor dem Senden geprüft. `upload()` schreibt/validiert über `/files` in Chunks à 6000
  Byte (nie mitten in einer UTF-8-Sequenz) als **ein** Queue-Job, damit nichts zwischen die Chunks gerät.
- **Circuit Breaker bei Auth-Fehlern** (`closed` → `open` → `probing` → `blocked`): Code `1` → 60s keine Anfragen,
  danach genau ein Probe-Request mit neu gelesenem Passwort; schlägt der fehl → `blocked`, bis sich das Passwort
  aus der Quelle (`password_file`) ändert. Code 1 nie automatisch wiederholen (5 Fehlversuche → 60s IP-Sperre).
  Nur Basic-Auth verwenden, nie `auth.login`-Sessions (nur ein Login-Slot am Gerät).
- **Profile** `read` ⊂ `operate` ⊂ `develop` ⊂ `admin` gelten für die ganze Instanz (= ein Eintrag in der
  Client-Konfiguration, `WEBSPS_PROFILE` bzw. top-level `profile` in der JSON), **kein** Profil pro Gerät — wer
  unterschiedliche Rechte je Gerät braucht, legt einen zweiten Eintrag an. Der Agent kann das Profil nicht ändern.
  `tools/list` zeigt nur die Tools des konfigurierten Profils.
  Rollen: `develop` = programmieren inkl. RUN/STOP/NTPSYNC (`device_control`) und REINIT/REBOOT
  (`device_reboot`); `admin` = zusätzlich **konfigurieren** (`config_set`, `device_maintenance`: Uhr stellen,
  Logdatei löschen). Am Gerät je Profil ein eigener Benutzer mit passender `PERM_*`-Maske: read 18925,
  operate 84463, develop 118783 (ohne `CONFIG_WRITE`, mit `SYSTEM_CONTROL`; setzt voraus, dass die Firmware
  `io.label_set` über `RULES_WRITE` statt `CONFIG_WRITE` prüft), admin 122879. `CONFIG_SECRETS` und
  `CONFIG_CRITICAL` bekommt kein Agentenprofil.
- **`STATE_DIR`** (`WEBSPS_STATE_DIR` > `state_dir` in der JSON > `$XDG_STATE_HOME`/`~/.local/state/websps-mcp`
  bzw. `%LOCALAPPDATA%\websps-mcp\state`), pro Gerät ein Unterordner `<alias>/`, wird erst beim ersten Schreiben
  angelegt. Inhalt: `console.jsonl` (Konsolen-Akkumulator, `src/device/consoleLog.ts`: holt bei jedem `log_read`
  die 25 Gerätezeilen und hängt neue per `seq` an; Cursor ist die eigene `pos`, da `seq` beim Reboot neu beginnt),
  `samples/<id>.jsonl` (Aufzeichnungen von `sample`, `src/device/sampler.ts`: Header, Samples, End-Zeile; nach
  Server-Neustart weiter lesbar), `audit.jsonl` (jeder Aufruf eines schreibenden Tools: Eintrag `started` vor der
  Operation, danach `ok`/`error` mit gleicher `id` und `duration_ms`; ohne Secrets und ohne Dateiinhalte —
  `auditedHandler` in `tools/common.ts`), `backups/<zeitstempel>_<pfad>` (alter
  Inhalt vor jedem Überschreiben/Löschen; das Gerät hält nur eine `.BAK`-Generation), `device.lock`. Aufbewahrung (`Retention` in
  `src/config.ts`, JSON `retention` bzw. `WEBSPS_KEEP_BACKUPS`/`WEBSPS_AUDIT_MAX_MB`/`WEBSPS_RECORDINGS_MAX_DAYS`):
  20 Backups je Datei, Audit-Rotation ab 10 MB × 5, Aufzeichnungen 30 Tage/100 Stück, Konsole 5000 Zeilen —
  aufgeräumt wird nur beim Schreiben, laufende Aufzeichnungen nie. Tests setzen immer ein temporäres
  `WEBSPS_STATE_DIR`.
- **Sicheres Schreiben** (`safeWrite` in `src/device/fileOps.ts`, genutzt von `rules_write`/`file_write`):
  existiert die Datei, ist `expected_hash` Pflicht und wird vorab geprüft → Backup → Upload mit Hash → danach
  CRC der Gerätedatei gegen das Gesendete prüfen. `rules_write` validiert vorher immer (Gerät + `lintRules` aus
  `src/device/rulesLint.ts`, Operatorliste live per `rules.operators`) und normalisiert auf CRLF.
- **`rules_activate`**: setzt ggf. den Root, `rules.reload`. Meldet das **Gerät** den Fehler (Code < 1000 außer
  AUTH) und war es ein **Wechsel** auf eine andere Datei, setzt der Server den vorherigen Root zurück und lädt ihn
  neu (das Gerät rollt nur auf die `.BAK` derselben Datei zurück — eine neue Datei hat keine). Bei Timeout,
  Netzwerk- oder Circuit-Breaker-Fehlern ist das Ergebnis unbekannt (das einfädige Gerät lädt evtl. noch
  erfolgreich): **kein** Rollback, Hinweis auf `device_status`. Meldet danach `system.status`; nach einem
  Fehlschlag bleibt das Gerät in STOP und braucht `device_control RUN` (ab Profil `develop`).
- **Secrets**: `config_get` maskiert Felder mit `secret:true` im Schema **und** Namen wie `*pass*`/`*token*` immer
  als `***` (`src/device/configSchema.ts`) — unabhängig davon, ob der Gerätebenutzer `config_secrets` hat.
- **Ergebnisse aufbereitet, Nicht-Zuordenbares unverändert im Feld `extra`.**
  - Label-Anreicherung (`{channel, value, label}`) aus einem `io.labels`-Cache pro Gerät (TTL ~60s, sofort
    invalidiert nach eigenem `io_label_set`) — nicht bei jedem `io_read` live nachfragen.
  - `io.read_all` entpacken, Zuordnung **nicht hart kodieren**:
    - Generische Regel: jedes Feld `<Op>B` mit Byte-Array ist der gepackte Bit-Zustand des Operanden `<Op>`,
      Bit 0 = niederwertigstes Bit (`VB[0]=17` → V0.0, V0.4); Anzahl aus der Array-Länge (× 8). Das deckt auch
      Felder ab, die in der Doku-Tabelle fehlen, z.B. `WB` = VKE der Analogkanäle, Operand `W0.0`–`W5.7`.
    - Bezeichnungen/Typen aus der Tabelle „Variablen ID“ in `/system/html/dat_vis.htm` des jeweiligen Geräts
      parsen und pro Gerät cachen (bleibt synchron mit der Firmware). Die „Anzahl“-Spalte dort ignorieren
      (variantenabhängig mit Fußnoten, z.B. „¹ 8/16“).
    - Nicht zuordenbare Felder (z.B. `status`, `cycle`, `msgcnt`) unverändert in `extra` durchreichen. Schlägt das
      Laden der Tabelle fehl, gilt nur die generische Regel (neuer Versuch nach 5 min).
    - Umgesetzt in `src/device/readAll.ts`; `io_read all:true` listet bei Bit-Operanden nur die gesetzten Kanäle
      (`on`), bei Wertgruppen >16 nur Werte ≠ 0 (`zero_omitted`), plus `labeled` für alle beschrifteten Kanäle.
- **Lange Vorgänge** (`sample`, Warten auf `rules_activate`) über ein Start/Abruf-Muster mit vom Server vergebenem
  Handle — nicht über MCP-Tasks und nicht synchron blockierend (Client-Timeouts ca. 50–60s).

## Fallstricke der Geräte-API

- HTTP-Status ist **immer 200**; `ok` / `error.code` im Body prüfen. Gerätefehler als MCP-`isError` mit
  `{code, name, hint}` abbilden. Falsches Passwort und fehlende Auth liefern beide Code 1.
- **Firmware-Stände unterscheiden sich, `firmware_version` aber nicht** (`V5.0B Analog`). Neuere Firmware meldet
  Fähigkeiten in `api.describe.api_features` (z.B. `io_read_ct_value_alias`, `io_read_analog_channels`,
  `files_list_name_aliases`, `config_schema_section`). Der Server muss auf beiden Ständen funktionieren; bisher
  kommt er ohne Feature-Abfragen aus (Rückfälle greifen nur bei Fehlern).
- `io.read` liefert für `Cx.x`/`Tx.x` nur das Flag „Sollwert erreicht“, nicht den Zähl-/Zeitwert. Neuere Firmware
  liest `CVx.x`/`TVx.x` und `AE`/`AA`/`SW` direkt; ältere meldet dafür einen Fehler pro Eintrag — `io_read` holt
  dann die Werte aus `io.read_all`. `"mode":"value"` nicht verwenden: ältere Firmware ignoriert es stillschweigend.
  Fehler pro Batch-Eintrag sind deutsche Freitexte — nicht auf den Text prüfen. Immer die Batch-Form
  `{"channels":[…]}` senden (die Einzelform meldet auf älterer Firmware unbekannte Kanäle irreführend).
- `api.describe` braucht keine Berechtigung (gut für Erreichbarkeitsprüfung); Hilfeseiten liegen unter
  `/system/html/` (per GET, HTTP-Status dort normal; `dat_rul.htm` ≈ 74 KB HTML).
- Ältere Firmware schreibt bei **jedem API-Request** eine Konsolenzeile „API Basic-Auth OK …“ (füllt den
  25-Zeilen-Ringpuffer); neuere nur noch Fehlversuche, dafür „AUDIT: …“-Zeilen bei Schreibzugriffen.
- `logs.search`: aktuelle Firmware durchsucht standardmäßig nur das Dateiende (16 KB, ohne genug Treffer bis
  128 KB; ~0,7–5 s) und meldet `searched_from_byte`/`file_size` (`log_read` leitet daraus `complete` ab);
  `full_scan:true` durchsucht alles (~11 s bei 336 KB, bis ~35 s bei 1 MB; Gerät blockiert, Timeout 45 s); ein
  nicht-boolesches `full_scan` (wie unbekanntes `mode`) ergibt PARAMS — der Server sendet nur `true`. Ältere Firmware durchsucht immer alles, ist case-sensitiv und
  kürzt Logzeilen auf ~60 Zeichen. `system.log` liefert neueste Einträge zuerst.
- `files.list {directory, page}`: Namen ohne Größe, 32 je Seite, mit `"-"` aufgefüllt (`listFiles` in
  `tools/files.ts` blättert und filtert). Ältere Firmware lehnt jedes Verzeichnis ab. Für `rules` immer
  `rules.list` (Größen und Root-Datei).
- `config.schema` ist paginiert (`page`, 30 je Seite), neuere Firmware liefert pro Feld `section`;
  `config.get_section` funktioniert erst auf neuerer Firmware (ältere: immer `{}`). `config.get_multi` lässt
  unbekannte Schlüssel stillschweigend weg. `config.get`/`get_section` liefern mit `config_secrets` Passwörter im
  Klartext — deshalb maskiert `config_get` immer.
- `/files` ist **immer POST**, auch beim Lesen; Schreiben über das Wire-Format mit `---CONTENT---`-Trenner, ab
  ~6KB in Chunks (`BODY_SIZE=8192`), max. 32767 Byte pro Datei, kein Offset/Range-Lesen. Fehler kommen beim Lesen
  als JSON-Body statt Inhalt; `file_read` hasht deshalb zuerst und prüft den Inhalt per CRC (unterscheidet Inhalt
  von Fehler, erkennt Änderung zwischendurch). Über 32767 Byte scheitert schon `action:"hash"` (Code 6).
- Prüfsumme ist **CRC-16/XMODEM** (Polynom `0x1021`, Startwert `0`, keine Spiegelung, kein End-XOR) — lässt sich
  für `expected_hash` lokal berechnen.
- Harte Grenzen, die `api.describe` nicht meldet (fest im Server hinterlegen): 32 Einträge bei
  `io.read`/`io.write`-Batches und `config.get_multi`; Kanalnamen ≤15 Byte. Längen in **Byte** zählen (UTF-8 wird
  unverändert durchgereicht; beim Chunking keine Mehrbyte-Sequenzen zerschneiden). Rules-Dateien mit CRLF erzeugen.
- `rules.reload` blockiert bis ~4s — für Reload-artige Methoden Timeout ≥10s.
- `rules.list` ist ungefiltert: `.BAK`-Dateien und `SYMBOLIK.INI` aus Listen ausblenden, Schreiben/Löschen darauf
  verweigern. 8.3-Dateinamen vor dem Senden prüfen.
- Bei `system.control` nur die Befehlsnamen verwenden, nie die Ziffern-Aliase.
- **Upload-Format** `/files`: `<JSON-Header>\n---CONTENT---\n<Rohbytes>`; Header `{path, action?, chunk?, chunks?,
  expected_hash?}`. `expected_hash` prüft das Gerät **nur beim letzten Chunk** (deshalb bei jedem mitsenden).
  `action:"validate"` geht auch in Chunks. Rules-Namen: 8.3 mit `.TXT`; schreibbar nur `rules/`, `mails/`, `svg/`,
  `htm/`. Die Antwort meldet `"backup":"X.BAK"` auch dann, wenn es keine vorherige Datei gab.
- `rules.reload` bei Fehler: Code 6 mit Text; mit vorhandener `.BAK` Rollback und Zustand **STOP**, ohne `.BAK`
  Zustand **RULES (−1)** ohne Rollback. Nach einem Fehler bleibt das Gerät auch nach erfolgreichem Reload in STOP.
  `rules.set_root` meldet „erst mit REINIT/Reboot aktiv“, `rules.reload` aktiviert den neuen Root aber sofort.
  `rules.delete` der aktiven Root-Datei → Code 2 (der Server prüft das vorher selbst).
- `io.write`: Batch `{"writes":[{channel,value}]}` mit Ergebnis pro Eintrag; Analogwerte werden **ungeprüft**
  umgewandelt (`"abc"` → 0, Erfolg!) — Werte prüft `writeValue` in `tools/ioWrite.ts`. `SW`-Bereich 0–100 prüft
  das Gerät. Labels bis 100 Byte verifiziert.
- `files.delete` erwartet `{directory, filename}` (nicht `path`); auf älterer Firmware scheitert es wie
  `files.list` an der Verzeichnisprüfung.

## Server-Invarianten (im Code erzwingen, nicht im Prompt)

- `rules_write` führt immer zuerst `rules_validate` aus; Backup und `expected_hash` sind Pflicht; Schreiben aktiviert nichts.
- `force` bei `rules.delete` nie nach außen geben (aktive Root-Datei bleibt über den Server unlöschbar).
- `rules_activate` ersetzt das laufende Programm nur mit `expected_root` = **geladener** Root (`loaded_root`,
  nicht `configured_root` — beide weichen nach `set_root` ohne Reload ab); sonst Fehler VALIDATION vor jedem
  `set_root`/`reload`, `details.current_root` (und `configured_root`, falls abweichend). Reload der laufenden Datei
  braucht keine Bestätigung.
- Rules-Zeilen vor dem Senden auf leere mittlere Parameter prüfen (strtok fasst aufeinanderfolgende `;` zusammen
  und verschiebt die Felder still; das Gerät warnt nur mit Code 110).
- `io_write` erlaubt nur `S`/`M`/`V`/`U`/`AA`/`SW`.
- Tool-Ergebnisse: vollständiges Ergebnis als kompaktes JSON im Text-`content` plus `structuredContent`;
  Annotationen (`readOnlyHint`/`destructiveHint`) sind nur Hinweise. `tools/list` deterministisch sortieren.
  Diagnose über `stderr` (stdout gehört bei stdio dem Protokoll).
- Server-`instructions` und Tool-Beschreibungen auf Englisch (internationales Produkt).
- **Tool-Schemas eindeutig halten:** keine alternativen Top-Level-Formen für dieselbe Eingabe (z.B. nicht
  `channel`+`value` *oder* `writes`) — Modelle füllen sonst beide aus und wiederholen den Fehler (live beobachtet).
  `oneOf`/`anyOf` an der Schema-Wurzel ist nicht portabel (manche Clients/Anbieter verlangen ein schlichtes
  Objekt). Wo sich Parameter ausschließen, nennt die Fehlermeldung konkret, welche Felder übergeben wurden und
  welches weg muss. Unbekannte Zusatzfelder werden vom SDK ignoriert.
- Kein `switch`-Tool — anlagenspezifische Impuls-/Pegel-Logik gehört in den Kontext des Agenten, nicht in den Server.

## Betriebshinweis

Das Gerät spricht nur Klartext-HTTP (kein TLS) und darf nie direkt aus dem Internet erreichbar sein.
