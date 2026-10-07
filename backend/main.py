"""
Vokabeltrainer Backend (Multi-User)
------------------------------------
FastAPI-Server mit:
- Registrierung (frei für jeden) und Login per Passwort
- Session per HttpOnly-Cookie (serverseitig im Arbeitsspeicher gehalten - siehe Hinweis unten)
- Lektionen und Logdateien werden pro Nutzer getrennt gespeichert
- Admin-Bereich: Benutzer auflisten und entfernen (inkl. ihrer Lektionen/Logs)
  Der zuerst registrierte Nutzer wird automatisch Administrator.

Hinweis zu Sessions: Sie liegen im Arbeitsspeicher dieses einen Prozesses. Bei einem Neustart
des Servers müssen sich alle Nutzer neu anmelden. Für den Eigenbedarf/eine Handvoll Nutzer
(Familie, Klasse) ist das ausreichend; für einen produktiven Mehrserver-Betrieb bräuchte es
stattdessen einen gemeinsamen Session-Speicher (z.B. Redis).
"""

import hashlib
import json
import logging
import re
import secrets
import time
from pathlib import Path
from typing import List, Optional

from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Pfade
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
LEKTIONEN_DIR = BASE_DIR / "lektionen"   # Unterordner je Nutzer: lektionen/<nutzer>/<name>.json
LOG_DIR = BASE_DIR / "logs"              # Logdatei je Nutzer: logs/<nutzer>.log
USERS_FILE = BASE_DIR / "users.json"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

LEKTIONEN_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)

SESSION_COOKIE = "session"
SESSION_GUELTIGKEIT_SEKUNDEN = 14 * 24 * 60 * 60  # 14 Tage

# token -> {"username": ..., "ablauf": <unix-zeit>}
SESSIONS: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Logging (pro Nutzer eine eigene Logdatei)
# ---------------------------------------------------------------------------
_logger_cache: dict[str, logging.Logger] = {}


def logger_fuer(username: str) -> logging.Logger:
    if username in _logger_cache:
        return _logger_cache[username]
    logger = logging.getLogger(f"vokabeltrainer.{username}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.FileHandler(LOG_DIR / f"{username}.log", encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
        logger.addHandler(handler)
    _logger_cache[username] = logger
    return logger


# ---------------------------------------------------------------------------
# Datenmodelle
# ---------------------------------------------------------------------------
class Vokabel(BaseModel):
    de: str
    en: str
    satzDe: str = ""
    satzEn: str = ""


class LektionCreate(BaseModel):
    name: str
    vokabeln: List[Vokabel] = Field(default_factory=list)
    gruppe: str = ""


class Lektion(BaseModel):
    name: str
    vokabeln: List[Vokabel]
    gruppe: str = ""


class EinzelErgebnis(BaseModel):
    de: str
    en: str
    richtung: str
    gegeben: str
    richtig: bool


class AbfrageLog(BaseModel):
    lektion: str
    richtung: str
    ergebnisse: List[EinzelErgebnis]


class TestLog(BaseModel):
    lektion: str
    ergebnisse: List[EinzelErgebnis]
    punkte: int
    max_punkte: int
    prozent: float
    note: int


class RegistrierungDaten(BaseModel):
    username: str
    passwort: str


class LoginDaten(BaseModel):
    username: str
    passwort: str


class EinstellungenUpdate(BaseModel):
    sekunden_pro_vokabel: int


# ---------------------------------------------------------------------------
# Globale Einstellungen (aktuell: Zeitlimit-Basis für den Test-Modus)
# ---------------------------------------------------------------------------
EINSTELLUNGEN_FILE = BASE_DIR / "einstellungen.json"
EINSTELLUNGEN_STANDARD = {"sekunden_pro_vokabel": 15}


def einstellungen_laden() -> dict:
    if not EINSTELLUNGEN_FILE.exists():
        return dict(EINSTELLUNGEN_STANDARD)
    with EINSTELLUNGEN_FILE.open("r", encoding="utf-8") as f:
        daten = json.load(f)
    for key, wert in EINSTELLUNGEN_STANDARD.items():
        daten.setdefault(key, wert)
    return daten


def einstellungen_speichern(daten: dict) -> None:
    with EINSTELLUNGEN_FILE.open("w", encoding="utf-8") as f:
        json.dump(daten, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Passwort-Hashing (nur Standardbibliothek: PBKDF2-HMAC-SHA256)
# ---------------------------------------------------------------------------
def passwort_hashen(passwort: str, salt: Optional[str] = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    hash_ = hashlib.pbkdf2_hmac("sha256", passwort.encode("utf-8"), salt.encode("utf-8"), 200_000).hex()
    return hash_, salt


def passwort_pruefen(passwort: str, hash_gespeichert: str, salt: str) -> bool:
    hash_, _ = passwort_hashen(passwort, salt)
    return secrets.compare_digest(hash_, hash_gespeichert)


# ---------------------------------------------------------------------------
# Benutzerverwaltung (users.json)
# ---------------------------------------------------------------------------
def nutzer_laden() -> dict:
    if not USERS_FILE.exists():
        return {}
    with USERS_FILE.open("r", encoding="utf-8") as f:
        return json.load(f)


def nutzer_speichern(daten: dict) -> None:
    with USERS_FILE.open("w", encoding="utf-8") as f:
        json.dump(daten, f, ensure_ascii=False, indent=2)


USERNAME_REGEX = re.compile(r"^[A-Za-z0-9_\-]{3,32}$")


def username_validieren(username: str) -> str:
    username = (username or "").strip()
    if not USERNAME_REGEX.match(username):
        raise HTTPException(
            status_code=400,
            detail="Benutzername muss 3-32 Zeichen lang sein (Buchstaben, Ziffern, _ und - erlaubt).",
        )
    return username


def sichere_dateiname(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Lektionsname darf nicht leer sein.")
    if not re.match(r"^[A-Za-z0-9_\- äöüÄÖÜß]+$", name):
        raise HTTPException(status_code=400, detail="Ungültige Zeichen im Lektionsnamen.")
    return name


def lektionen_dir_fuer(username: str) -> Path:
    d = LEKTIONEN_DIR / username
    d.mkdir(parents=True, exist_ok=True)
    return d


def lektion_pfad(username: str, name: str) -> Path:
    return lektionen_dir_fuer(username) / f"{sichere_dateiname(name)}.json"


# ---------------------------------------------------------------------------
# Sessions / Auth-Dependencies
# ---------------------------------------------------------------------------
def session_aufraeumen() -> None:
    jetzt = time.time()
    abgelaufen = [t for t, s in SESSIONS.items() if s["ablauf"] < jetzt]
    for t in abgelaufen:
        del SESSIONS[t]


def session_erstellen(username: str) -> str:
    session_aufraeumen()
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {"username": username, "ablauf": time.time() + SESSION_GUELTIGKEIT_SEKUNDEN}
    return token


def aktueller_nutzername(session: Optional[str] = Cookie(default=None)) -> str:
    if not session or session not in SESSIONS:
        raise HTTPException(status_code=401, detail="Nicht angemeldet.")
    eintrag = SESSIONS[session]
    if eintrag["ablauf"] < time.time():
        del SESSIONS[session]
        raise HTTPException(status_code=401, detail="Sitzung abgelaufen, bitte erneut anmelden.")
    username = eintrag["username"]
    # Zusätzliche Absicherung: falls der Nutzer inzwischen gelöscht wurde
    if username not in nutzer_laden():
        del SESSIONS[session]
        raise HTTPException(status_code=401, detail="Konto existiert nicht mehr.")
    return username


def aktueller_admin(username: str = Depends(aktueller_nutzername)) -> str:
    nutzer = nutzer_laden()
    if not nutzer.get(username, {}).get("ist_admin"):
        raise HTTPException(status_code=403, detail="Nur für Administratoren.")
    return username


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Vokabeltrainer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:
        logging.error("Unbehandelter Fehler bei %s %s: %s", request.method, request.url.path, exc)
        raise


# ---------------------------------------------------------------------------
# Auth-Endpunkte
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
def registrieren(daten: RegistrierungDaten, response: Response):
    username = username_validieren(daten.username)
    if len(daten.passwort) < 6:
        raise HTTPException(status_code=400, detail="Passwort muss mindestens 6 Zeichen lang sein.")

    nutzer = nutzer_laden()
    if username in nutzer:
        raise HTTPException(status_code=409, detail="Benutzername bereits vergeben.")

    hash_, salt = passwort_hashen(daten.passwort)
    ist_admin = len(nutzer) == 0  # erster registrierter Nutzer wird automatisch Administrator
    nutzer[username] = {"hash": hash_, "salt": salt, "ist_admin": ist_admin}
    nutzer_speichern(nutzer)
    logger_fuer(username).info("Konto registriert (ist_admin=%s)", ist_admin)

    token = session_erstellen(username)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=SESSION_GUELTIGKEIT_SEKUNDEN)
    return {"username": username, "ist_admin": ist_admin}


@app.post("/api/auth/login")
def anmelden(daten: LoginDaten, response: Response):
    username = (daten.username or "").strip()
    nutzer = nutzer_laden()
    eintrag = nutzer.get(username)
    if not eintrag or not passwort_pruefen(daten.passwort, eintrag["hash"], eintrag["salt"]):
        raise HTTPException(status_code=401, detail="Benutzername oder Passwort falsch.")

    token = session_erstellen(username)
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=SESSION_GUELTIGKEIT_SEKUNDEN)
    logger_fuer(username).info("Angemeldet")
    return {"username": username, "ist_admin": eintrag.get("ist_admin", False)}


@app.post("/api/auth/logout")
def abmelden(response: Response, session: Optional[str] = Cookie(default=None)):
    if session and session in SESSIONS:
        username = SESSIONS[session]["username"]
        del SESSIONS[session]
        logger_fuer(username).info("Abgemeldet")
    response.delete_cookie(SESSION_COOKIE)
    return {"status": "ok"}


@app.get("/api/auth/me")
def eigenes_konto(username: str = Depends(aktueller_nutzername)):
    nutzer = nutzer_laden()
    return {"username": username, "ist_admin": nutzer.get(username, {}).get("ist_admin", False)}


# ---------------------------------------------------------------------------
# Admin-Endpunkte
# ---------------------------------------------------------------------------
@app.get("/api/admin/users")
def admin_nutzerliste(admin: str = Depends(aktueller_admin)):
    nutzer = nutzer_laden()
    return {
        "nutzer": [
            {"username": name, "ist_admin": info.get("ist_admin", False)}
            for name, info in sorted(nutzer.items())
        ]
    }


@app.delete("/api/admin/users/{username}")
def admin_nutzer_loeschen(username: str, admin: str = Depends(aktueller_admin)):
    if username == admin:
        raise HTTPException(status_code=400, detail="Das eigene Administrator-Konto kann nicht über diesen Weg gelöscht werden.")
    nutzer = nutzer_laden()
    if username not in nutzer:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")

    del nutzer[username]
    nutzer_speichern(nutzer)

    # Lektionen und Logdatei des gelöschten Nutzers mit entfernen
    nutzer_dir = LEKTIONEN_DIR / username
    if nutzer_dir.exists():
        for datei in nutzer_dir.glob("*.json"):
            datei.unlink()
        nutzer_dir.rmdir()
    log_datei = LOG_DIR / f"{username}.log"
    if log_datei.exists():
        log_datei.unlink()

    # aktive Sessions dieses Nutzers invalidieren
    for token, s in list(SESSIONS.items()):
        if s["username"] == username:
            del SESSIONS[token]

    logger_fuer(admin).info("Benutzer '%s' von Administrator entfernt", username)
    return {"status": "ok"}


@app.get("/api/einstellungen")
def einstellungen_lesen(username: str = Depends(aktueller_nutzername)):
    return einstellungen_laden()


@app.put("/api/admin/einstellungen")
def einstellungen_aktualisieren(daten: EinstellungenUpdate, admin: str = Depends(aktueller_admin)):
    if not (1 <= daten.sekunden_pro_vokabel <= 600):
        raise HTTPException(status_code=400, detail="Sekunden pro Vokabel muss zwischen 1 und 600 liegen.")
    neue = einstellungen_laden()
    neue["sekunden_pro_vokabel"] = daten.sekunden_pro_vokabel
    einstellungen_speichern(neue)
    logger_fuer(admin).info("Einstellung geändert: sekunden_pro_vokabel=%d", daten.sekunden_pro_vokabel)
    return neue


# ---------------------------------------------------------------------------
# Lektionen-Endpunkte (je angemeldetem Nutzer getrennt)
# ---------------------------------------------------------------------------
@app.get("/api/lektionen")
def lektionen_liste(username: str = Depends(aktueller_nutzername)):
    ergebnis = []
    for pfad in sorted(lektionen_dir_fuer(username).glob("*.json")):
        gruppe = ""
        try:
            with pfad.open("r", encoding="utf-8") as f:
                gruppe = json.load(f).get("gruppe", "")
        except (json.JSONDecodeError, OSError):
            pass
        ergebnis.append({"name": pfad.stem, "gruppe": gruppe})
    ergebnis.sort(key=lambda x: x["name"])
    return {"lektionen": ergebnis}


@app.get("/api/lektionen/{name}", response_model=Lektion)
def lektion_laden(name: str, username: str = Depends(aktueller_nutzername)):
    pfad = lektion_pfad(username, name)
    if not pfad.exists():
        logger_fuer(username).warning("Lektion nicht gefunden: %s", name)
        raise HTTPException(status_code=404, detail="Lektion nicht gefunden.")
    with pfad.open("r", encoding="utf-8") as f:
        return json.load(f)


@app.post("/api/lektionen", response_model=Lektion)
def lektion_anlegen(lektion: LektionCreate, username: str = Depends(aktueller_nutzername)):
    pfad = lektion_pfad(username, lektion.name)
    if pfad.exists():
        raise HTTPException(status_code=409, detail="Lektion existiert bereits.")
    data = {"name": lektion.name, "vokabeln": [v.dict() for v in lektion.vokabeln], "gruppe": lektion.gruppe}
    with pfad.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger_fuer(username).info("Lektion angelegt: '%s' mit %d Vokabeln (Gruppe: '%s')", lektion.name, len(lektion.vokabeln), lektion.gruppe)
    return data


@app.put("/api/lektionen/{name}", response_model=Lektion)
def lektion_aktualisieren(name: str, lektion: LektionCreate, username: str = Depends(aktueller_nutzername)):
    pfad = lektion_pfad(username, name)
    if not pfad.exists():
        raise HTTPException(status_code=404, detail="Lektion nicht gefunden.")
    data = {"name": name, "vokabeln": [v.dict() for v in lektion.vokabeln], "gruppe": lektion.gruppe}
    with pfad.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger_fuer(username).info("Lektion aktualisiert: '%s', jetzt %d Vokabeln (Gruppe: '%s')", name, len(lektion.vokabeln), lektion.gruppe)
    return data


@app.delete("/api/lektionen/{name}")
def lektion_loeschen(name: str, username: str = Depends(aktueller_nutzername)):
    pfad = lektion_pfad(username, name)
    if not pfad.exists():
        raise HTTPException(status_code=404, detail="Lektion nicht gefunden.")
    pfad.unlink()
    logger_fuer(username).info("Lektion gelöscht: '%s'", name)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Logging-Endpunkte für Abfrage & Test
# ---------------------------------------------------------------------------
@app.post("/api/log/abfrage")
def abfrage_loggen(log: AbfrageLog, username: str = Depends(aktueller_nutzername)):
    logger = logger_fuer(username)
    logger.info("=== ABFRAGE gestartet | Lektion='%s' Richtung=%s ===", log.lektion, log.richtung)
    richtige = 0
    for e in log.ergebnisse:
        status = "RICHTIG" if e.richtig else "FALSCH"
        if e.richtig:
            richtige += 1
        else:
            logger.warning(
                "Abfrage-Fehler | Lektion='%s' Frage='%s' Erwartet='%s' Gegeben='%s' Richtung=%s",
                log.lektion, e.de if e.richtung == "de-en" else e.en,
                e.en if e.richtung == "de-en" else e.de, e.gegeben, e.richtung,
            )
        logger.info("Abfrage | %s | de='%s' en='%s' gegeben='%s'", status, e.de, e.en, e.gegeben)
    logger.info("=== ABFRAGE beendet | Lektion='%s' Richtig=%d/%d ===", log.lektion, richtige, len(log.ergebnisse))
    return {"status": "ok"}


@app.post("/api/log/test")
def test_loggen(log: TestLog, username: str = Depends(aktueller_nutzername)):
    logger = logger_fuer(username)
    logger.info("=== TEST gestartet | Lektion='%s' Anzahl Fragen=%d ===", log.lektion, len(log.ergebnisse))
    for e in log.ergebnisse:
        status = "RICHTIG" if e.richtig else "FALSCH"
        if not e.richtig:
            logger.warning(
                "Test-Fehler | Lektion='%s' de='%s' en='%s' Richtung=%s Gegeben='%s'",
                log.lektion, e.de, e.en, e.richtung, e.gegeben,
            )
        logger.info("Test | %s | de='%s' en='%s' Richtung=%s gegeben='%s'", status, e.de, e.en, e.richtung, e.gegeben)
    logger.info(
        "=== TEST beendet | Lektion='%s' Punkte=%d/%d (%.1f%%) Note=%d ===",
        log.lektion, log.punkte, log.max_punkte, log.prozent, log.note,
    )
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Frontend ausliefern (gleiche Origin, kein CORS-/Cookie-Ärger)
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
