# Vokabeltrainer

## Struktur
- `backend/` – FastAPI-Server (main.py), Multi-User (Registrierung/Login/Admin-Bereich),
  speichert Lektionen pro Nutzer in `backend/lektionen/<nutzer>/` und schreibt Aktionen/
  Ergebnisse/Fehler je Nutzer in `backend/logs/<nutzer>.log`
- `frontend/` – Vanilla-JS-Frontend, wird vom Backend automatisch mit ausgeliefert
- `azure-function/` – dieselbe Funktionalität als Azure Functions App (Blob Storage statt
  lokaler Dateien), siehe `azure-function/README.md`

## Starten

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Dann im Browser öffnen: http://localhost:8000/ – beim ersten Aufruf erscheint die
Anmelde-/Registrierungsseite; der **zuerst registrierte Nutzer wird automatisch Administrator**.

## Mehrbenutzerbetrieb
- **Registrierung**: frei, jeder kann sich mit Benutzername (3-32 Zeichen) und Passwort
  (mind. 6 Zeichen) selbst ein Konto anlegen.
- **Login**: Session per HttpOnly-Cookie, 14 Tage gültig. Beim FastAPI-Backend liegen Sessions
  im Arbeitsspeicher des Prozesses (bei Neustart müssen sich alle neu anmelden); bei der
  Azure-Function-Variante liegen sie als Blobs, damit sie auch über mehrere Instanzen hinweg
  funktionieren.
- **Lektionen und Logdateien sind strikt pro Nutzer getrennt** – ein Nutzer sieht und bearbeitet
  ausschließlich seine eigenen Lektionen, auch der Dateiname/Blob-Pfad enthält den
  Benutzernamen.
- **Admin-Bereich** (nur für den ersten registrierten Nutzer sichtbar, Button „Admin-Bereich“
  in der Kopfzeile): Liste aller Benutzer, Button „Entfernen“ löscht ein Konto inklusive all
  seiner Lektionen und seiner Logdatei. Das eigene Administrator-Konto kann dort nicht gelöscht
  werden (Schutz vor versehentlichem Aussperren).
- Passwörter werden nie im Klartext gespeichert (PBKDF2-HMAC-SHA256, 200.000 Iterationen,
  individueller Salt je Nutzer).

## Funktionen
- Lektion anlegen (Name + beliebig viele Deutsch/Englisch-Vokabelpaare), gespeichert als
  `backend/lektionen/<nutzer>/<Name>.json`
- Reihenfolge der Eingabefelder umschaltbar (Deutsch zuerst / Englisch zuerst)
- **Eingabe wird automatisch zwischengespeichert** (lokal im Browser, `localStorage`): Geht die
  Sitzung verloren oder wird die Seite neu geladen (F5), während eine Lektion angelegt oder
  bearbeitet wird, bleibt der Stand erhalten und wird beim nächsten Öffnen automatisch
  wiederhergestellt (mit Hinweis und Button „Entwurf verwerfen“). Der Zwischenspeicher wird
  erst beim erfolgreichen Speichern der Lektion gelöscht.
- **Fortschrittsbalken**: Bei Abfrage und Test wird der Fortschritt zusätzlich als Balken
  angezeigt. Bei der Abfrage bezieht er sich auf die Anzahl bereits korrekt beantworteter
  (gemeisterter) Vokabeln, nicht auf die reine Fragenanzahl - Wiederholungsrunden lassen ihn
  also nicht zurückspringen.
- **Caching bei Abfrage und Test**: Der Fortschritt wird laufend lokal zwischengespeichert
  (`localStorage`). Bricht die Sitzung ab (F5, Verbindungsabbruch, abgelaufenes Login), kann
  genau dort weitergemacht werden, wo man aufgehört hat - beim erneuten Start derselben
  Abfragerichtung bzw. desselben Tests erscheint ein Hinweis „Fortgesetzt von …“ mit der
  Möglichkeit, stattdessen neu zu starten. Beim Zeitlimit (siehe unten) läuft die Uhr beim
  Fortsetzen unverändert weiter.
- **Überspringen im Test**: Jede Testfrage kann einmal übersprungen werden; übersprungene
  Vokabeln werden am Ende erneut (und dann verpflichtend) abgefragt.
- **Zeitlimit im Test**: Das Zeitlimit berechnet sich aus der Anzahl der abzufragenden Vokabeln
  (= Vokabelanzahl × 2, da beide Richtungen geprüft werden) mal einem admin-konfigurierbaren
  Wert „Sekunden pro Vokabel“ (Standard: 15). Läuft die Zeit ab, werden alle noch offenen
  Fragen automatisch als falsch gewertet und der Test wird ausgewertet. Einstellbar im
  Admin-Bereich.
- **Lektionen gruppieren**: Beim Anlegen/Bearbeiten einer Lektion kann optional eine Gruppe
  angegeben werden (Freitext mit Autovervollständigung aus bereits verwendeten Gruppennamen).
  Auf der Startseite werden Lektionen nach Gruppe sortiert mit Überschrift angezeigt,
  Lektionen ohne Gruppe landen gesammelt unter „Ohne Gruppe“ am Ende.
- **Gruppentest**: Jede Gruppen-Überschrift hat einen Button „Gruppentest starten“, der die
  Vokabeln aller Lektionen dieser Gruppe zu einem gemeinsamen Test kombiniert (gleiche Logik
  wie der normale Test: beide Richtungen, Überspringen, Zeitlimit, Caching).
- **Diktat**: Button „🔊 Diktat starten“ in der Lektion-Detailansicht liest die deutschen
  Wörter (bei mehreren Varianten alle, z.B. „der Baum, der Stamm“) der Reihe nach vor - das
  Wort wird dabei bewusst nicht angezeigt, nur der Fortschritt. Der zeitliche Abstand zwischen
  den Wörtern ist derselbe admin-konfigurierbare Wert „Sekunden pro Vokabel“ wie beim
  Test-Zeitlimit. Pause/Fortsetzen möglich, am Ende gibt es eine Liste aller Wörter zum
  Selbst-Kontrollieren.
- **Beispielsätze (optional)**: Pro Vokabel können ein deutscher und ein englischer Beispielsatz
  hinterlegt werden. Bei der Abfrage wird passend zur Abfragerichtung der jeweilige Satz unter
  dem Wort angezeigt (Deutsch→Englisch: deutscher Satz, Englisch→Deutsch: englischer Satz). Im
  Test-Modus werden keine Beispielsätze angezeigt.
- **Mehrere deutsche Wörter je Vokabel**: Im "Deutsch"-Feld können mehrere Varianten durch `;`
  getrennt eingegeben werden (z.B. `der Tisch; das Pult`). Bei Abfrage und Test reicht es, eine
  davon zu nennen; bei der Anzeige werden alle Varianten durch " / " getrennt gezeigt.
- **Groß-/Kleinschreibung beachten (nur Abfrage)**: In der Lektion-Detailansicht lässt sich vor
  dem Start der Abfrage per Checkbox (Standard: aktiviert) einstellen, ob Englisch-Antworten
  case-sensitiv geprüft werden. Im Test-Modus bleibt es immer case-sensitiv.
- **Import/Export als JSON**: In der Lektion-Detailansicht lädt „Exportieren (JSON)“ die
  Lektion genau im gespeicherten Format herunter (`{ "name": ..., "vokabeln": [{ "de": ...,
  "en": ... }, ...] }`). Auf der Startseite importiert „Importieren (JSON)“ eine solche Datei
  wieder – fragt nach dem gewünschten Lektionsnamen und beim Überschreiben einer bereits
  bestehenden Lektion nochmal nach. Praktisch zum Sichern, Weitergeben oder Übertragen
  zwischen Web-Version, Android/iOS-App und Azure-Deployment (die Lektionen liegen je nach
  Variante an unterschiedlichen Orten, teilen aber dasselbe JSON-Format).
- Lektion öffnen, Vokabeln nachträglich bearbeiten oder löschen
- **Abfragen**: Richtung wählbar (Deutsch→Englisch oder Englisch→Deutsch). Falsch beantwortete
  Vokabeln werden sofort mit der richtigen Lösung angezeigt und am Ende der Runde erneut
  abgefragt (Wiederholungsrunden, bis alles sitzt).
- **Test starten**: jede Vokabel wird in beiden Richtungen abgefragt. Falsch beantwortete
  Vokabeln werden nicht wiederholt, es werden nur Punkte gezählt. Am Ende wird die Note nach
  dem Standard-Notenschlüssel für Gymnasium (6-stufig) berechnet:
  - 92–100 % → Note 1
  - 81–91 %  → Note 2
  - 67–80 %  → Note 3
  - 50–66 %  → Note 4
  - 30–49 %  → Note 5
  - 0–29 %   → Note 6
- Jede Abfrage- und Test-Sitzung wird inkl. aller Einzelergebnisse und Fehler in
  `backend/logs/app.log` protokolliert.

## Sprachausgabe
Nach jeder Auswertung (richtig/falsch) wird die korrekte Antwort per Browser-Sprachausgabe
(Web Speech API, Englisch en-GB / Deutsch de-DE) vorgelesen. Über „🔊 Nochmal anhören“ oder die
Taste R (bei fokussiertem „Weiter“) lässt sie sich wiederholen. Die Qualität hängt von den im
Gerät installierten Stimmen ab.
