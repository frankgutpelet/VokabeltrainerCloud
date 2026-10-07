# Vokabeltrainer – Azure Function (für VS Code)

Gleiche API und dieselbe Oberfläche wie das FastAPI-Backend, aber als Azure Functions App
gebaut. Grund für die Umstellung: In Azure (besonders im günstigen Consumption-Plan) bleibt
das lokale Dateisystem einer Function *nicht* zuverlässig zwischen Aufrufen erhalten – die
Vokabel-Dateien und die Logdatei liegen deshalb in **Azure Blob Storage**:

- Lektionen: JSON-Blob je Lektion und Nutzer, Pfad `<username>/<Name>.json` im Container
  `lektionen`
- Log: fortlaufendes **Append-Blob** `<username>.log` je Nutzer im Container `logs` (Append-Blobs
  sind genau für dieses Anwendungsmuster gemacht – günstiges, sequenzielles Anhängen)
- Nutzerkonten: Blob `users.json` im Container `users`
- Sessions: ein Blob je aktiver Sitzung im Container `sessions` (bewusst nicht im
  Prozessspeicher gehalten, da eine Function App über mehrere Instanzen skalieren kann)
- Frontend (`static/`, Kopie von `../frontend`) wird von derselben Function App mit ausgeliefert

**Mehrbenutzerbetrieb**: Registrierung ist frei, der zuerst registrierte Nutzer wird
automatisch Administrator und sieht den Admin-Bereich (Button in der Kopfzeile) zum Entfernen
von Benutzern inklusive deren Lektionen und Logdatei. Lektionen und Logs sind strikt pro Nutzer
getrennt. Details siehe `../README.md`.

Lokal getestet gegen den Storage-Emulator **Azurite** – alle Endpunkte (Registrierung, Login,
Logout, Admin-Nutzerliste/-Löschung inkl. Session-Invalidierung, Lektion anlegen/laden/ändern/
löschen pro Nutzer getrennt, doppelte Namen, Abfrage-/Test-Logging, Frontend-Auslieferung)
laufen wie erwartet.

## Voraussetzungen (einmalig)
- [VS Code](https://code.visualstudio.com/)
- Erweiterung **Azure Functions** (`ms-azuretools.vscode-azurefunctions`) – wird beim Öffnen
  des Ordners vorgeschlagen (`.vscode/extensions.json`)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Python 3.10–3.12
- Für lokale Tests **ohne** echtes Azure-Konto: [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite)
  (`npm install -g azurite`)

## Lokal starten
```bash
cd azure-function
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# in einem zweiten Terminal:
azurite --silent --location .azurite

# zurück im ersten Terminal:
func start
```
Dann `http://localhost:7071/` im Browser öffnen – das ist die komplette App (Frontend + API),
genau wie beim FastAPI-Server, nur eben mit Azure Functions dahinter.

In VS Code reicht alternativ **F5** (nutzt `.vscode/tasks.json` bzw. `launch.json`), Azurite muss
dafür aber vorher separat laufen.

`local.settings.json` enthält bereits `"AzureWebJobsStorage": "UseDevelopmentStorage=true"` –
das ist die feste Standard-Verbindungszeichenfolge für Azurite, keine Anpassung nötig.

## Deployment nach Azure
1. In VS Code: Azure-Symbol in der Seitenleiste → unter „Workspace“ auf das Function-App-Symbol
   klicken → **Deploy to Function App…** (legt bei Bedarf eine neue Function App + Storage
   Account in Azure an, oder wählt eine bestehende).
2. Wichtig: Der **Storage Account**, den die Function App beim Anlegen bekommt (Einstellung
   `AzureWebJobsStorage`), wird automatisch auch für `lektionen` und `logs` verwendet – kein
   zusätzlicher Storage Account nötig, aber die Container werden erst beim ersten Aufruf
   automatisch angelegt (kein manueller Schritt).
3. CORS: Falls das Frontend von einer anderen Domain aus zugreifen soll (hier nicht nötig, da
   Frontend + API aus derselben Function App kommen): Azure Portal → Function App →
   Einstellungen → CORS.
4. **Wichtig:** Die App-Einstellung `AzureWebJobsDisableHomepage: true` (lokal schon in
   `local.settings.json`) muss nach dem Deployment auch in Azure gesetzt werden – sonst zeigt
   die Root-URL `/` immer die Azure-Standard-Willkommensseite statt `index.html`. Im Azure
   Portal: Function App → Einstellungen → Umgebungsvariablen → Neue Anwendungseinstellung
   `AzureWebJobsDisableHomepage` = `true`.

## Nach Änderungen am Frontend
```bash
python sync-static.py
```
Kopiert `../frontend/*` erneut nach `static/`.

## Unterschiede zur FastAPI-Version
- Speicherung: Azure Blob Storage statt lokaler JSON-Dateien/Logdatei
- Route-Präfix ist in `host.json` auf leer gesetzt, API-Routen liegen deshalb explizit unter
  `api/...` (passt zu `const API = "/api"` im Frontend), alles andere liefert `static/` aus
- Kein eigener Uvicorn-Prozess/Port mehr nötig – `func start` bzw. die Azure Function App
  übernimmt Hosting und Skalierung
