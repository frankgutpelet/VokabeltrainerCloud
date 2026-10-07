"""Kopiert ../frontend nach static/, damit die Function App es mit ausliefert.
Nach Änderungen an frontend/ dieses Skript erneut ausführen: python sync-static.py
"""
import shutil
from pathlib import Path

src = Path(__file__).resolve().parent.parent / "frontend"
dst = Path(__file__).resolve().parent / "static"
dst.mkdir(exist_ok=True)
for name in ("index.html", "app.js", "style.css"):
    shutil.copyfile(src / name, dst / name)
print("static/ aktualisiert")
