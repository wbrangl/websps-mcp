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
```

Tests liegen neben dem Code (`src/**/*.test.ts`) und brauchen kein echtes Gerät: `src/testing/fakeDevice.ts` ist
ein lokaler HTTP-Server, der wie ein Web@SPS antwortet (inkl. selbst nachgebauter „Variablen ID“-Tabelle — keine
Firmware-Inhalte ins Repo kopieren). `src/e2e.test.ts` startet den Server per `tsx` über stdio und prüft ihn mit dem
Client-SDK in **beiden** Protokoll-Eras (`{ pin: "2026-07-28" }` und `legacy`). Manueller Test: JSON-RPC-Zeilen per
Pipe an `node dist/index.js` schicken (stdout = Protokoll, Logs nach stderr).

Private Hinweise (Designunterlagen, Testgerät) stehen in `CLAUDE.local.md`.

Dieses Repo wird unter MIT-Lizenz veröffentlicht: Keine Zugangsdaten, Kundennamen, internen IPs oder Inhalte aus
nicht öffentlichen Unterlagen in committete Dateien, Commits oder Testdaten übernehmen.

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

Umgesetzt: Konfiguration, Geräte-Client, Tools `devices_list`, `device_status`, `io_read`, `io_labels`.
Noch offen u.a.: Sperrdatei pro Gerät, `STATE_DIR`, alle schreibenden Tools.

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
- **Geräte-Client** (`src/device/client.ts`): eine Promise-Queue pro Gerät (Gerät ist einfädig). Über mehrere
  stdio-Prozesse hinweg später: Sperrdatei pro Gerät (best effort). Code `5` BUSY → bis zu 3 Wiederholungen mit
  Backoff. Body-Limit 8192 Byte wird vor dem Senden geprüft.
- **Circuit Breaker bei Auth-Fehlern** (`closed` → `open` → `probing` → `blocked`): Code `1` → 60s keine Anfragen,
  danach genau ein Probe-Request mit neu gelesenem Passwort; schlägt der fehl → `blocked`, bis sich das Passwort
  aus der Quelle (`password_file`) ändert. Code 1 nie automatisch wiederholen (5 Fehlversuche → 60s IP-Sperre).
  Nur Basic-Auth verwenden, nie `auth.login`-Sessions (nur ein Login-Slot am Gerät).
- **Profile** `read` ⊂ `operate` ⊂ `develop` ⊂ `admin` gelten für die ganze Instanz (= ein Eintrag in der
  Client-Konfiguration, `WEBSPS_PROFILE` bzw. top-level `profile` in der JSON), **kein** Profil pro Gerät — wer
  unterschiedliche Rechte je Gerät braucht, legt einen zweiten Eintrag an. Der Agent kann das Profil nicht ändern.
  `tools/list` zeigt nur die Tools des konfigurierten Profils.
  Riskante Tools (`config_set`, `device_control`, `device_reboot`) nur im Profil `admin`. Am Gerät zusätzlich je
  Profil ein eigener Benutzer mit passender `PERM_*`-Bitmaske.
- **`STATE_DIR`** enthält Log-Akkumulator, Sampling-Aufzeichnungen, JSONL-Audit-Log aller Schreibzugriffe und
  zeitgestempelte Backups vor jedem Schreiben (das Gerät hält nur eine `.BAK`-Generation).
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
- `io.read` kennt **keine Wert-Operanden** (Zählwerte `CV`, Zeitwerte `TV`, Analog `AE`/`AA`/`SW` → Eintrag mit
  `error`); `io_read` holt diese deshalb aus `io.read_all`. Fehler pro Batch-Eintrag sind deutsche Freitexte — nicht
  auf den Text prüfen. Immer die Batch-Form `{"channels":[…]}` senden: die Einzelform `{"channel":…}` meldet bei
  unbekannten Kanälen irreführend „Parameter 'channel' nicht vorhanden“.
- `api.describe` braucht keine Berechtigung (gut für Erreichbarkeitsprüfung); Hilfeseiten liegen unter
  `/system/html/` (per GET, HTTP-Status dort normal).
- `/files` ist **immer POST**, auch beim Lesen; Schreiben über das Wire-Format mit `---CONTENT---`-Trenner, ab
  ~6KB in Chunks (`BODY_SIZE=8192`), max. 32767 Byte pro Datei, kein Offset/Range-Lesen (vorher `bytes` per
  `action:"hash"` prüfen und klar scheitern statt still abzuschneiden).
- Prüfsumme ist **CRC-16/XMODEM** (Polynom `0x1021`, Startwert `0`, keine Spiegelung, kein End-XOR) — lässt sich
  für `expected_hash` lokal berechnen.
- Harte Grenzen, die `api.describe` nicht meldet (fest im Server hinterlegen): 32 Einträge bei
  `io.read`/`io.write`-Batches und `config.get_multi`; Kanalnamen ≤15 Byte. Längen in **Byte** zählen (UTF-8 wird
  unverändert durchgereicht; beim Chunking keine Mehrbyte-Sequenzen zerschneiden). Rules-Dateien mit CRLF erzeugen.
- `rules.reload` blockiert bis ~4s — für Reload-artige Methoden Timeout ≥10s.
- `rules.list` ist ungefiltert: `.BAK`-Dateien und `SYMBOLIK.INI` aus Listen ausblenden, Schreiben/Löschen darauf
  verweigern. 8.3-Dateinamen vor dem Senden prüfen.
- Bei `system.control` nur die Befehlsnamen verwenden, nie die Ziffern-Aliase.

## Server-Invarianten (im Code erzwingen, nicht im Prompt)

- `rules_write` führt immer zuerst `rules_validate` aus; Backup und `expected_hash` sind Pflicht; Schreiben aktiviert nichts.
- `force` bei `rules.delete` nie nach außen geben (aktive Root-Datei bleibt über den Server unlöschbar).
- Rules-Zeilen vor dem Senden auf leere mittlere Parameter prüfen (strtok fasst aufeinanderfolgende `;` zusammen
  und verschiebt die Felder still; das Gerät warnt nur mit Code 110).
- `io_write` erlaubt nur `S`/`M`/`V`/`U`/`AA`/`SW`.
- Tool-Ergebnisse: vollständiges Ergebnis als kompaktes JSON im Text-`content` plus `structuredContent`;
  Annotationen (`readOnlyHint`/`destructiveHint`) sind nur Hinweise. `tools/list` deterministisch sortieren.
  Diagnose über `stderr` (stdout gehört bei stdio dem Protokoll).
- Server-`instructions` und Tool-Beschreibungen auf Englisch (internationales Produkt).
- Kein `switch`-Tool — anlagenspezifische Impuls-/Pegel-Logik gehört in den Kontext des Agenten, nicht in den Server.

## Betriebshinweis

Das Gerät spricht nur Klartext-HTTP (kein TLS) und darf nie direkt aus dem Internet erreichbar sein.
