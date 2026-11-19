# Maestro

English: [README.md](README.md)

Maestro ist ein Mod mit Skill für den Code-Tab der Claude-Desktop-App. Eine Master-Session nimmt deine Aufträge an und verteilt sie an Arbeits-Sessions mit passendem Modell. Sie überwacht Fortschritt, Limits und Kontext und archiviert fertige Sessions.

```
🎼 Musik  📌 2  ❓1 🔄2 ☑️1  ▰▰▰▱▱ 58 %  5h 25 %  ready
❓ farb-wahl ▰▰▱▱▱ 40 % · Welche Farbe?
🔄 layout-bau ▰▰▰▱▱ 50 % · Band bauen
🔄 mix ▱▱▱▱▱ 0 % · Spuren einlesen
☑️ wissen ▰▰▰▰▰ 100 % · Bestand eingearbeitet
```

Das Band steht immer zwischen Chatverlauf und Texteingabe und zeigt das Wichtigste auf kleinem Raum. Die Kopfzeile bleibt eine Zeile; wird es eng, kürzt sie zuerst den Text. Die festen Texte des Bands (etwa `ready`) sind englisch.

| Zeichen | Bedeutung |
|---|---|
| 📌 | so viele offene Punkte stehen auf der Liste |
| `5h 25 %` | 5-Stunden-Limit, ab 80 % hervorgehoben als ⚠️ |
| ❓ | wartet auf dich: eine Frage oder eine Freigabe-Karte |
| ⚠️ | seit über 20 Minuten keine Meldung, oder als eigene Zeile: Dateikonflikt |
| 🔄 | arbeitet |
| ⏸️ | Runde zu Ende, Aufgabenliste aber nicht |
| ☑️ | die Session hat sich fertig gemeldet, Maestro hat es noch nicht geprüft |
| ✅ | von Maestro geprüft, verschwindet nach 30 Minuten |

Das Band ist eine reine Anzeige mit höchstens 5 Zeilen. Passen nicht alle Sessions hinein, stehen die dringendsten oben und der Rest gezählt in einer Sammelzeile (`… and 3 more: 🔄1 ☑️2`).

Alle Eingaben machst du bei Maestro: Er leitet deine Antworten an Sessions weiter und stoppt sie, wenn du es sagst. Nur Freigabe-Karten, Auswahl-Fragen und Anhänge bleiben technisch im Fenster der jeweiligen Session.

Der Skill-Text ist englisch. Maestro antwortet in deiner Sprache.

## Offene Punkte

Keine gute Idee soll auf der Strecke bleiben. Maestro hält eigene Vorschläge, unbeantwortete Fragen, Zurückgestelltes und offene Fragen aus den Meldungen der Sessions in einer Liste fest (`open_add`) und nennt am Ende jeder Antwort die Anzahl. Die Liste übersteht `/clear` und Neustart. Ein Punkt verschwindet nur mit Beleg oder auf dein Wort (`open_close`, Pflichtfeld `reason`).

Die Mod hilft dabei auf zwei Wegen: Jede deiner Nachrichten bringt Maestro die offene Liste mit, und eine Stichwortprüfung erinnert ihn, wenn seine Antwort nach Vorschlag oder Frage klingt, ohne dass er etwas festgehalten hat. Die Prüfung trägt nichts selbst ein.

## Installieren

In der Desktop-App: **+** neben dem Eingabefeld, dann **Plugins**, **Add marketplace** mit `fadenshine/maestro`, dann **Add plugin**.

Im Terminal, an der Eingabe einer Session:

```
/plugin install maestro --marketplace fadenshine/maestro
```

Oder aus der Shell:

```
claude plugin install maestro --marketplace fadenshine/maestro
```

Danach einen neuen Chat öffnen und den Skill `maestro` aufrufen. Läuft schon ein Maestro, lädt `/reload-plugins` in dessen Chat die Mod neu.

## Von dirigent kommend

Maestro ist der umbenannte dirigent (0.9.0). Um deine Daten mitzunehmen:

```
node tools/migrate-from-dirigent.mjs
```

Das Skript kopiert offene Punkte, Skill-Statistik, Übergaben und Master-Einträge aus `~/.claude/dirigent/` nach `~/.claude/maestro/`. Der alte Ordner bleibt unverändert. Alte Auftrags-Marken `⟦dirigent:…⟧` werden nicht mehr erkannt.

## Skill-Verwaltung

Maestro hilft, dass passende Skills genutzt und gepflegt werden. Er weist Arbeits-Sessions in der Auftragszeile `Skills:` passende Skills zu, die Mod schreibt mit, welche Skills wirklich geladen werden (das Band zeigt `[name]` oder `[name?]`, wenn der Skill noch nicht geladen ist), und das Werkzeug `skills_status` fasst Nutzung, Lücken und Aufräum-Kandidaten zusammen. Mitgelieferte Skills (etwa `update-config`) kennt `skills_status` nicht; sie nimmt der Master aus seiner eigenen Skill-Liste. Hinweise zu Skills hält `skill_note` fest; daraus entstehen Entwürfe unter `proposals/`.

Wird ein Skill geändert, merkt sich `skill_change` Datum und Sicherung. `skills_status` vergleicht dann Erfolgsquote und Hinweise vorher und nachher; unter 5 Nutzungen je Seite sagt es, dass die Daten nicht reichen. Wird es schlechter, schlägt Maestro vor, die Sicherung zurückzuspielen.

Passt ein fremder Skill oder ein Plugin aus dem Internet und würde die Arbeit am Projekt deutlich effizienter machen, schlägt Maestro auch das vor: von selbst höchstens einmal je Projekt und höchstens 3 auf einmal, je Vorschlag mit Name, Link, Nutzen, Quelle und Risiko. Eine günstige, nur lesende Session recherchiert dafür und prüft Herkunft, Pflege, Lizenz, Rechte und Inhalt; sie lädt nichts herunter und führt nichts aus. Findet sie nichts deutlich Besseres, hörst du nichts davon. Jeder Vorschlag landet als offener Punkt, und was du ablehnst, kommt mit Grund nicht wieder.

Maestro **schlägt nur vor**. Er ändert keinen Skill ohne dein Wort, installiert fremde Skills nur auf dein ausdrückliches Wort zu genau diesem Vorschlag und ändert keine Einstellungen selbst; zum Ausblenden selten genutzter Skills liefert `skills_hide` nur einen Befehl, den du selbst ausführst. Aufräum-Kandidaten gibt es erst nach 30 Tagen Protokoll.

## Bevor du es benutzt

- **Maestro arbeitet mit weiten Freigaben.** Er schaltet seine Session in den Auto-Modus (die App fragt dich einmal), und Arbeits-Sessions erben ihn. Sie bekommen den Auftrag, selbständig und ohne Rückfrage zu arbeiten. Endgültiges Löschen, Veröffentlichen, Pushen und Nachrichten an andere Menschen sollen sie nur tun, wenn dein Auftrag das ausdrücklich sagt. Das ist eine Anweisung an das Modell und keine technische Sperre. Nutze Maestro nur für Arbeit, bei der du damit leben kannst.
- **Er verbraucht schneller deine Limits**, weil mehrere Sessions gleichzeitig laufen.
- **Er archiviert fertige Sessions automatisch** und bereinigt seinen eigenen Chat, wenn der Kontext voll wird.
- **Nur für die Desktop-App.** Er braucht deren Session-Werkzeuge; im reinen Terminal oder mit `claude -p` funktioniert er nicht.
- **Frühe Programmierschnittstelle.** Claude Code nennt die Mod-Schnittstelle „early access“; ein Update kann den Mod brechen.

## Was wo liegt

Alles bleibt auf deinem Rechner, der Mod sendet nichts ins Netz. Er ruft nur lokale Dienste der App auf (Titel, Limit). Nur eine Recherche-Session für Skill-Vorschläge sucht im Netz, wie jede Session, die das darf; sie schickt dabei Suchanfragen zum Projekt hinaus.

| Was | Wo |
|---|---|
| Stand jeder Session (Aufgabenliste, kurzer Bericht) | `~/.claude/maestro/status/` |
| `local_…`-Id und geänderte Dateien jeder Session | `~/.claude/maestro/extra/` |
| Welche Sessions Maestro geprüft hat | `~/.claude/maestro/checked/` |
| Offene Punkte je Maestro | `~/.claude/maestro/open/<code>.json` |
| Skill-Protokoll (welche Session welche Skills lud), Hinweise und Änderungen zu Skills | `~/.claude/maestro/skills/` (`usage`, `notes`, `changes`) |
| Entwürfe für neue Skills und Änderungsvorschläge (nicht aktiv) | `~/.claude/maestro/proposals/` |
| Sicherungen von Skills vor einer Änderung | `~/.claude/maestro/skill-backup/` |
| Übergaben von Maestro | `~/.claude/maestro/handoff-<code>.md` |
| Zuordnung von Master und Arbeits-Sessions | Speicher des Mods unter `~/.claude/plugins/store/` |

`<code>` ist die Kennung eines Masters (8 Zeichen).

## Grenzen

- Das Band ist nur so aktuell wie die Aufgabenlisten der Sessions; jeder Auftrag verlangt deshalb, die Liste zu führen.
- Setzt die App eine Session nach einem Neustart fort, bekommt sie eine neue Session-Id. Der Mod erkennt sie an der Host-Id der App wieder und übernimmt Stand, Projekt und offene Punkte. Im Terminal gibt es keine Host-Id; dort beginnt eine fortgesetzte Session mit neuer Id ohne Maestro.
- Stand-Dateien bleiben liegen, werden nach 7 Tagen aber nicht mehr gelesen. Auch ein nie geprüftes ☑️ verschwindet dann.
- Abgestürzte Sessions zeigen ab 20 Minuten ⚠️ und verschwinden nach 24 Stunden.
- Dateikonflikte: Das Band warnt, wenn zwei noch nicht geprüfte Sessions dieselbe Datei geändert haben, auch wenn eine schon fertig gemeldet ist. Erst die Prüfung (✅) oder das Ende einer Session nimmt sie aus dem Vergleich. Erkannt wird das nur bei `Write`, `Edit` und `NotebookEdit`, auch aus Unteragenten. Was eine Session über Bash ändert (`sed`, `git`, Skripte), ist nicht erfassbar. Sessions in eigenen Worktrees haben andere Pfade und gelten nicht als Konflikt.
- Das Band kann das Chatende verdecken. Die App legt die Eingabespalte samt Band über das Ende des Chats und hält es nur frei, solange der Chat mitläuft. Hast du hochgescrollt oder in den Chat geklickt, laufen neue Antworten dahinter weiter; einmal ganz nach unten scrollen schaltet das Mitlaufen wieder ein. Der Mod kann weder das Band anders platzieren noch den Chat selbst bewegen; er hält das Band nur klein.
- Nach `/reload-plugins` verschwindet das Band kurz, bis der neu geladene Mod wieder zeichnet.
- Die Stichwortprüfung für offene Punkte erinnert auch mal grundlos und übersieht anders Formuliertes. Verlässlich wird die Liste durch Maestro, nicht durch die Prüfung.
- Das Limit im Band stammt aus `get_usage` und wird höchstens einmal pro Minute gelesen. Geht das nicht, zeigt das Band nichts dazu.
- Getestet ist der Mod bisher nur auf einem Mac mit Claude Code 2.1.325.

## Entwickeln

```
claude plugin validate .
claude plugin test .
```

## Lizenz

MIT, siehe [LICENSE](LICENSE).
