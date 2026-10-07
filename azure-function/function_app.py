"""
Vokabeltrainer - Azure Functions Backend (Multi-User)
-------------------------------------------------------
Gleiche Funktionalität wie backend/main.py (FastAPI), aber für Azure Functions:

- Registrierung (frei für jeden) und Login per Passwort
- Session per HttpOnly-Cookie, serverseitig als Blob gehalten (Container "sessions") -
  bewusst NICHT im Prozessspeicher, da eine Function App über mehrere Instanzen
  skalieren kann und In-Memory-Sessions dann nicht überall sichtbar wären
- Lektionen und Logs werden pro Nutzer getrennt gespeichert:
  - Lektionen: Blob "<username>/<name>.json" im Container "lektionen"
  - Logs: Append-Blob "<username>.log" im Container "logs"
- Nutzerliste: Blob "users.json" im Container "users"
- Admin-Bereich: Benutzer auflisten und entfernen (inkl. ihrer Lektionen/Logs).
  Der zuerst registrierte Nutzer wird automatisch Administrator.
- Frontend (static/) wird von derselben Function App mit ausgeliefert
"""

import hashlib
import json
import mimetypes
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

import azure.functions as func
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

STATIC_DIR = Path(__file__).resolve().parent / "static"
LEKTIONEN_CONTAINER = "lektionen"
LOGS_CONTAINER = "logs"
USERS_CONTAINER = "users"
USERS_BLOB = "users.json"
SESSIONS_CONTAINER = "sessions"
EINSTELLUNGEN_CONTAINER = "einstellungen"
EINSTELLUNGEN_BLOB = "config.json"
EINSTELLUNGEN_STANDARD = {"sekunden_pro_vokabel": 15}

SESSION_COOKIE = "session"
SESSION_GUELTIGKEIT_SEKUNDEN = 14 * 24 * 60 * 60  # 14 Tage

USERNAME_REGEX = re.compile(r"^[A-Za-z0-9_\-]{3,32}$")


# ---------------------------------------------------------------------------
# Fehler-Hilfstyp (Ersatz für FastAPIs HTTPException)
# ---------------------------------------------------------------------------
class ApiFehler(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------------------
# Blob-Storage-Hilfsfunktionen
# ---------------------------------------------------------------------------
def blob_service() -> BlobServiceClient:
    conn = os.environ["AzureWebJobsStorage"]
    return BlobServiceClient.from_connection_string(conn)


def sicherstellen_container(bs: BlobServiceClient, name: str):
    try:
        bs.create_container(name)
    except ResourceExistsError:
        pass


def sichere_dateiname(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ApiFehler(400, "Lektionsname darf nicht leer sein.")
    if not re.match(r"^[A-Za-z0-9_\- äöüÄÖÜß]+$", name):
        raise ApiFehler(400, "Ungültige Zeichen im Lektionsnamen.")
    return name


def username_validieren(username: str) -> str:
    username = (username or "").strip()
    if not USERNAME_REGEX.match(username):
        raise ApiFehler(400, "Benutzername muss 3-32 Zeichen lang sein (Buchstaben, Ziffern, _ und - erlaubt).")
    return username


# ---------------------------------------------------------------------------
# Passwort-Hashing (nur Standardbibliothek: PBKDF2-HMAC-SHA256)
# ---------------------------------------------------------------------------
def passwort_hashen(passwort: str, salt: str | None = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    hash_ = hashlib.pbkdf2_hmac("sha256", passwort.encode("utf-8"), salt.encode("utf-8"), 200_000).hex()
    return hash_, salt


def passwort_pruefen(passwort: str, hash_gespeichert: str, salt: str) -> bool:
    hash_, _ = passwort_hashen(passwort, salt)
    return secrets.compare_digest(hash_, hash_gespeichert)


# ---------------------------------------------------------------------------
# Benutzerverwaltung
# ---------------------------------------------------------------------------
def nutzer_laden(bs: BlobServiceClient) -> dict:
    client = bs.get_blob_client(container=USERS_CONTAINER, blob=USERS_BLOB)
    try:
        return json.loads(client.download_blob().readall())
    except ResourceNotFoundError:
        return {}


def nutzer_speichern(bs: BlobServiceClient, daten: dict):
    sicherstellen_container(bs, USERS_CONTAINER)
    bs.get_blob_client(container=USERS_CONTAINER, blob=USERS_BLOB).upload_blob(
        json.dumps(daten, ensure_ascii=False, indent=2), overwrite=True
    )


# ---------------------------------------------------------------------------
# Globale Einstellungen (aktuell: Zeitlimit-Basis für den Test-Modus)
# ---------------------------------------------------------------------------
def einstellungen_laden(bs: BlobServiceClient) -> dict:
    client = bs.get_blob_client(container=EINSTELLUNGEN_CONTAINER, blob=EINSTELLUNGEN_BLOB)
    try:
        daten = json.loads(client.download_blob().readall())
    except ResourceNotFoundError:
        return dict(EINSTELLUNGEN_STANDARD)
    for key, wert in EINSTELLUNGEN_STANDARD.items():
        daten.setdefault(key, wert)
    return daten


def einstellungen_speichern(bs: BlobServiceClient, daten: dict):
    sicherstellen_container(bs, EINSTELLUNGEN_CONTAINER)
    bs.get_blob_client(container=EINSTELLUNGEN_CONTAINER, blob=EINSTELLUNGEN_BLOB).upload_blob(
        json.dumps(daten, ensure_ascii=False, indent=2), overwrite=True
    )


# ---------------------------------------------------------------------------
# Sessions (als Blobs - skaliert über mehrere Function-Instanzen hinweg)
# ---------------------------------------------------------------------------
def session_erstellen(bs: BlobServiceClient, username: str) -> str:
    sicherstellen_container(bs, SESSIONS_CONTAINER)
    token = secrets.token_urlsafe(32)
    daten = {"username": username, "ablauf": time.time() + SESSION_GUELTIGKEIT_SEKUNDEN}
    bs.get_blob_client(container=SESSIONS_CONTAINER, blob=token).upload_blob(json.dumps(daten), overwrite=True)
    return token


def session_loeschen(bs: BlobServiceClient, token: str):
    try:
        bs.get_blob_client(container=SESSIONS_CONTAINER, blob=token).delete_blob()
    except ResourceNotFoundError:
        pass


def cookie_lesen(req: func.HttpRequest, name: str) -> str | None:
    header = req.headers.get("Cookie", "")
    for teil in header.split(";"):
        teil = teil.strip()
        if teil.startswith(f"{name}="):
            return teil[len(name) + 1:]
    return None


def session_cookie_setzen(headers: dict, token: str):
    headers["Set-Cookie"] = (
        f"{SESSION_COOKIE}={token}; HttpOnly; Path=/; Max-Age={SESSION_GUELTIGKEIT_SEKUNDEN}; SameSite=Lax"
    )


def session_cookie_loeschen(headers: dict):
    headers["Set-Cookie"] = f"{SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"


def aktueller_nutzername(req: func.HttpRequest, bs: BlobServiceClient) -> str:
    token = cookie_lesen(req, SESSION_COOKIE)
    if not token:
        raise ApiFehler(401, "Nicht angemeldet.")
    client = bs.get_blob_client(container=SESSIONS_CONTAINER, blob=token)
    try:
        daten = json.loads(client.download_blob().readall())
    except ResourceNotFoundError:
        raise ApiFehler(401, "Nicht angemeldet.")
    if daten["ablauf"] < time.time():
        session_loeschen(bs, token)
        raise ApiFehler(401, "Sitzung abgelaufen, bitte erneut anmelden.")
    username = daten["username"]
    # Zusätzliche Absicherung: falls der Nutzer inzwischen gelöscht wurde (z.B. eine
    # Session, die beim Löschen aus irgendeinem Grund nicht mit entfernt wurde)
    if username not in nutzer_laden(bs):
        session_loeschen(bs, token)
        raise ApiFehler(401, "Konto existiert nicht mehr.")
    return username


def aktueller_admin(req: func.HttpRequest, bs: BlobServiceClient) -> str:
    username = aktueller_nutzername(req, bs)
    nutzer = nutzer_laden(bs)
    if not nutzer.get(username, {}).get("ist_admin"):
        raise ApiFehler(403, "Nur für Administratoren.")
    return username


# ---------------------------------------------------------------------------
# Lektionen (pro Nutzer getrennt: Blob "<username>/<name>.json")
# ---------------------------------------------------------------------------
def lektion_lesen(bs: BlobServiceClient, username: str, name: str):
    client = bs.get_blob_client(container=LEKTIONEN_CONTAINER, blob=f"{username}/{name}.json")
    try:
        return json.loads(client.download_blob().readall())
    except ResourceNotFoundError:
        return None


def lektion_schreiben(bs: BlobServiceClient, username: str, name: str, vokabeln: list, gruppe: str = ""):
    data = {"name": name, "vokabeln": vokabeln, "gruppe": gruppe}
    client = bs.get_blob_client(container=LEKTIONEN_CONTAINER, blob=f"{username}/{name}.json")
    client.upload_blob(json.dumps(data, ensure_ascii=False, indent=2), overwrite=True)
    return data


# ---------------------------------------------------------------------------
# Logging (pro Nutzer ein Append-Blob)
# ---------------------------------------------------------------------------
def log_zeile(username: str, level: str, message: str):
    try:
        bs = blob_service()
        sicherstellen_container(bs, LOGS_CONTAINER)
        client = bs.get_blob_client(container=LOGS_CONTAINER, blob=f"{username}.log")
        if not client.exists():
            client.create_append_blob()
        zeit = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        client.append_block(f"{zeit} | {level} | {message}\n".encode("utf-8"))
    except Exception:
        pass  # Logging darf die eigentliche Anfrage nie zum Scheitern bringen


def note_berechnen(prozent: float) -> int:
    if prozent >= 92:
        return 1
    elif prozent >= 81:
        return 2
    elif prozent >= 67:
        return 3
    elif prozent >= 50:
        return 4
    elif prozent >= 30:
        return 5
    return 6


def json_response(data, status_code: int = 200, headers: dict | None = None) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(data, ensure_ascii=False),
        status_code=status_code,
        mimetype="application/json",
        headers=headers or {},
    )


def fehler_response(nachricht: str, status_code: int = 400) -> func.HttpResponse:
    return json_response({"detail": nachricht}, status_code)


# ---------------------------------------------------------------------------
# Auth-Endpunkte
# ---------------------------------------------------------------------------
@app.route(route="api/auth/register", methods=["POST"])
def registrieren(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        username = username_validieren(body.get("username"))
        passwort = body.get("passwort", "")
        if len(passwort) < 6:
            raise ApiFehler(400, "Passwort muss mindestens 6 Zeichen lang sein.")

        bs = blob_service()
        nutzer = nutzer_laden(bs)
        if username in nutzer:
            raise ApiFehler(409, "Benutzername bereits vergeben.")

        hash_, salt = passwort_hashen(passwort)
        ist_admin = len(nutzer) == 0
        nutzer[username] = {"hash": hash_, "salt": salt, "ist_admin": ist_admin}
        nutzer_speichern(bs, nutzer)
        log_zeile(username, "INFO", f"Konto registriert (ist_admin={ist_admin})")

        token = session_erstellen(bs, username)
        headers = {}
        session_cookie_setzen(headers, token)
        return json_response({"username": username, "ist_admin": ist_admin}, headers=headers)
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)
    except ValueError:
        return fehler_response("Ungültiger Request-Body.")


@app.route(route="api/auth/login", methods=["POST"])
def anmelden(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return fehler_response("Ungültiger Request-Body.")

    username = (body.get("username") or "").strip()
    passwort = body.get("passwort", "")
    bs = blob_service()
    nutzer = nutzer_laden(bs)
    eintrag = nutzer.get(username)
    if not eintrag or not passwort_pruefen(passwort, eintrag["hash"], eintrag["salt"]):
        return fehler_response("Benutzername oder Passwort falsch.", 401)

    token = session_erstellen(bs, username)
    headers = {}
    session_cookie_setzen(headers, token)
    log_zeile(username, "INFO", "Angemeldet")
    return json_response({"username": username, "ist_admin": eintrag.get("ist_admin", False)}, headers=headers)


@app.route(route="api/auth/logout", methods=["POST"])
def abmelden(req: func.HttpRequest) -> func.HttpResponse:
    bs = blob_service()
    token = cookie_lesen(req, SESSION_COOKIE)
    if token:
        try:
            daten = json.loads(bs.get_blob_client(container=SESSIONS_CONTAINER, blob=token).download_blob().readall())
            log_zeile(daten["username"], "INFO", "Abgemeldet")
        except ResourceNotFoundError:
            pass
        session_loeschen(bs, token)
    headers = {}
    session_cookie_loeschen(headers)
    return json_response({"status": "ok"}, headers=headers)


@app.route(route="api/auth/me", methods=["GET"])
def eigenes_konto(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        username = aktueller_nutzername(req, bs)
        nutzer = nutzer_laden(bs)
        return json_response({"username": username, "ist_admin": nutzer.get(username, {}).get("ist_admin", False)})
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)


# ---------------------------------------------------------------------------
# Admin-Endpunkte
# ---------------------------------------------------------------------------
@app.route(route="api/admin/users", methods=["GET"])
def admin_nutzerliste(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        aktueller_admin(req, bs)
        nutzer = nutzer_laden(bs)
        return json_response({
            "nutzer": [
                {"username": name, "ist_admin": info.get("ist_admin", False)}
                for name, info in sorted(nutzer.items())
            ]
        })
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)


@app.route(route="api/admin/users/{username}", methods=["DELETE"])
def admin_nutzer_loeschen(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        admin = aktueller_admin(req, bs)
        username = req.route_params.get("username")

        if username == admin:
            raise ApiFehler(400, "Das eigene Administrator-Konto kann nicht über diesen Weg gelöscht werden.")

        nutzer = nutzer_laden(bs)
        if username not in nutzer:
            raise ApiFehler(404, "Benutzer nicht gefunden.")
        del nutzer[username]
        nutzer_speichern(bs, nutzer)

        # Lektionen des Nutzers entfernen
        sicherstellen_container(bs, LEKTIONEN_CONTAINER)
        container = bs.get_container_client(LEKTIONEN_CONTAINER)
        for b in container.list_blobs(name_starts_with=f"{username}/"):
            container.delete_blob(b.name)

        # Logdatei entfernen
        try:
            bs.get_blob_client(container=LOGS_CONTAINER, blob=f"{username}.log").delete_blob()
        except ResourceNotFoundError:
            pass

        # Aktive Sessions des gelöschten Nutzers invalidieren (sonst bliebe ein
        # vorhandenes Cookie bis zum natürlichen Ablauf gültig)
        sicherstellen_container(bs, SESSIONS_CONTAINER)
        sessions_container = bs.get_container_client(SESSIONS_CONTAINER)
        for b in sessions_container.list_blobs():
            try:
                inhalt = json.loads(sessions_container.download_blob(b.name).readall())
                if inhalt.get("username") == username:
                    sessions_container.delete_blob(b.name)
            except Exception:
                continue

        log_zeile(admin, "INFO", f"Benutzer '{username}' von Administrator entfernt")
        return json_response({"status": "ok"})
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)


@app.route(route="api/einstellungen", methods=["GET"])
def einstellungen_lesen(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        aktueller_nutzername(req, bs)
        return json_response(einstellungen_laden(bs))
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)


@app.route(route="api/admin/einstellungen", methods=["PUT"])
def einstellungen_aktualisieren(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        admin = aktueller_admin(req, bs)
        body = req.get_json()
        sekunden = body.get("sekunden_pro_vokabel")
        if not isinstance(sekunden, int) or not (1 <= sekunden <= 600):
            raise ApiFehler(400, "Sekunden pro Vokabel muss zwischen 1 und 600 liegen.")
        neue = einstellungen_laden(bs)
        neue["sekunden_pro_vokabel"] = sekunden
        einstellungen_speichern(bs, neue)
        log_zeile(admin, "INFO", f"Einstellung geändert: sekunden_pro_vokabel={sekunden}")
        return json_response(neue)
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)
    except ValueError:
        return fehler_response("Ungültiger Request-Body.")


# ---------------------------------------------------------------------------
# Lektionen-Endpunkte (je angemeldetem Nutzer getrennt)
# ---------------------------------------------------------------------------
@app.route(route="api/lektionen", methods=["GET"])
def lektionen_liste(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        username = aktueller_nutzername(req, bs)
        sicherstellen_container(bs, LEKTIONEN_CONTAINER)
        container = bs.get_container_client(LEKTIONEN_CONTAINER)
        prefix = f"{username}/"
        ergebnis = []
        for b in container.list_blobs(name_starts_with=prefix):
            if not b.name.endswith(".json"):
                continue
            name = b.name[len(prefix):-5]
            gruppe = ""
            try:
                gruppe = json.loads(container.download_blob(b.name).readall()).get("gruppe", "")
            except Exception:
                pass
            ergebnis.append({"name": name, "gruppe": gruppe})
        ergebnis.sort(key=lambda x: x["name"])
        return json_response({"lektionen": ergebnis})
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)


@app.route(route="api/lektionen", methods=["POST"])
def lektion_anlegen(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        username = aktueller_nutzername(req, bs)
        body = req.get_json()
        name = sichere_dateiname(body.get("name"))

        sicherstellen_container(bs, LEKTIONEN_CONTAINER)
        if lektion_lesen(bs, username, name) is not None:
            raise ApiFehler(409, "Lektion existiert bereits.")

        vokabeln = body.get("vokabeln", [])
        gruppe = body.get("gruppe", "")
        data = lektion_schreiben(bs, username, name, vokabeln, gruppe)
        log_zeile(username, "INFO", f"Lektion angelegt: '{name}' mit {len(vokabeln)} Vokabeln (Gruppe: '{gruppe}')")
        return json_response(data)
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)
    except ValueError:
        return fehler_response("Ungültiger Request-Body.")


@app.route(route="api/lektionen/{name}", methods=["GET", "PUT", "DELETE"])
def lektion_einzeln(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        username = aktueller_nutzername(req, bs)
        name = sichere_dateiname(req.route_params.get("name"))
        sicherstellen_container(bs, LEKTIONEN_CONTAINER)

        if req.method == "GET":
            data = lektion_lesen(bs, username, name)
            if data is None:
                log_zeile(username, "WARNING", f"Lektion nicht gefunden: {name}")
                raise ApiFehler(404, "Lektion nicht gefunden.")
            return json_response(data)

        if req.method == "PUT":
            if lektion_lesen(bs, username, name) is None:
                raise ApiFehler(404, "Lektion nicht gefunden.")
            try:
                body = req.get_json()
            except ValueError:
                raise ApiFehler(400, "Ungültiger Request-Body.")
            vokabeln = body.get("vokabeln", [])
            gruppe = body.get("gruppe", "")
            data = lektion_schreiben(bs, username, name, vokabeln, gruppe)
            log_zeile(username, "INFO", f"Lektion aktualisiert: '{name}', jetzt {len(vokabeln)} Vokabeln (Gruppe: '{gruppe}')")
            return json_response(data)

        if req.method == "DELETE":
            if lektion_lesen(bs, username, name) is None:
                raise ApiFehler(404, "Lektion nicht gefunden.")
            bs.get_blob_client(container=LEKTIONEN_CONTAINER, blob=f"{username}/{name}.json").delete_blob()
            log_zeile(username, "INFO", f"Lektion gelöscht: '{name}'")
            return json_response({"status": "ok"})

        return fehler_response("Methode nicht erlaubt.", 405)
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)


# ---------------------------------------------------------------------------
# Logging-Endpunkte für Abfrage & Test
# ---------------------------------------------------------------------------
@app.route(route="api/log/abfrage", methods=["POST"])
def abfrage_loggen(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        username = aktueller_nutzername(req, bs)
        body = req.get_json()
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)
    except ValueError:
        return fehler_response("Ungültiger Request-Body.")

    lektion = body.get("lektion", "")
    richtung = body.get("richtung", "")
    ergebnisse = body.get("ergebnisse", [])

    log_zeile(username, "INFO", f"=== ABFRAGE gestartet | Lektion='{lektion}' Richtung={richtung} ===")
    richtige = 0
    for e in ergebnisse:
        status = "RICHTIG" if e.get("richtig") else "FALSCH"
        if e.get("richtig"):
            richtige += 1
        else:
            erwartet = e.get("en") if e.get("richtung") == "de-en" else e.get("de")
            frage = e.get("de") if e.get("richtung") == "de-en" else e.get("en")
            log_zeile(
                username, "WARNING",
                f"Abfrage-Fehler | Lektion='{lektion}' Frage='{frage}' "
                f"Erwartet='{erwartet}' Gegeben='{e.get('gegeben')}' Richtung={e.get('richtung')}",
            )
        log_zeile(username, "INFO", f"Abfrage | {status} | de='{e.get('de')}' en='{e.get('en')}' gegeben='{e.get('gegeben')}'")
    log_zeile(username, "INFO", f"=== ABFRAGE beendet | Lektion='{lektion}' Richtig={richtige}/{len(ergebnisse)} ===")
    return json_response({"status": "ok"})


@app.route(route="api/log/test", methods=["POST"])
def test_loggen(req: func.HttpRequest) -> func.HttpResponse:
    try:
        bs = blob_service()
        username = aktueller_nutzername(req, bs)
        body = req.get_json()
    except ApiFehler as e:
        return fehler_response(e.detail, e.status_code)
    except ValueError:
        return fehler_response("Ungültiger Request-Body.")

    lektion = body.get("lektion", "")
    ergebnisse = body.get("ergebnisse", [])
    punkte = body.get("punkte", 0)
    max_punkte = body.get("max_punkte", 0)
    prozent = body.get("prozent", 0)
    note = body.get("note", note_berechnen(prozent))

    log_zeile(username, "INFO", f"=== TEST gestartet | Lektion='{lektion}' Anzahl Fragen={len(ergebnisse)} ===")
    for e in ergebnisse:
        status = "RICHTIG" if e.get("richtig") else "FALSCH"
        if not e.get("richtig"):
            log_zeile(
                username, "WARNING",
                f"Test-Fehler | Lektion='{lektion}' de='{e.get('de')}' en='{e.get('en')}' "
                f"Richtung={e.get('richtung')} Gegeben='{e.get('gegeben')}'",
            )
        log_zeile(username, "INFO", f"Test | {status} | de='{e.get('de')}' en='{e.get('en')}' Richtung={e.get('richtung')} gegeben='{e.get('gegeben')}'")
    log_zeile(
        username, "INFO",
        f"=== TEST beendet | Lektion='{lektion}' Punkte={punkte}/{max_punkte} ({float(prozent):.1f}%) Note={note} ===",
    )
    return json_response({"status": "ok"})


# ---------------------------------------------------------------------------
# Frontend ausliefern (static/, deployt mit der Function App) - KEIN Login nötig,
# die Login/Registrierungs-Seite selbst ist Teil der statischen App.
# ---------------------------------------------------------------------------
def statische_datei_ausliefern(dateiname: str) -> func.HttpResponse:
    ziel = (STATIC_DIR / dateiname).resolve()
    if STATIC_DIR not in ziel.parents and ziel != STATIC_DIR:
        return func.HttpResponse("Not found", status_code=404)
    if not ziel.exists() or not ziel.is_file():
        return func.HttpResponse("Not found", status_code=404)
    content_type = mimetypes.guess_type(str(ziel))[0] or "application/octet-stream"
    return func.HttpResponse(ziel.read_bytes(), status_code=200, mimetype=content_type)


@app.route(route="{default:maxlength(0)?}", methods=["GET"])
def frontend_index(req: func.HttpRequest) -> func.HttpResponse:
    return statische_datei_ausliefern("index.html")


# Nur EIN Pfadsegment (z.B. "app.js", "style.css") - trifft "api/lektionen" (2 Segmente)
# dadurch niemals.
@app.route(route="{dateiname}", methods=["GET"])
def frontend_datei(req: func.HttpRequest) -> func.HttpResponse:
    dateiname = req.route_params.get("dateiname") or ""
    return statische_datei_ausliefern(dateiname)
