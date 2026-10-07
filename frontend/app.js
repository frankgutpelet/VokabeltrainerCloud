"use strict";

const API = "/api";
const content = document.getElementById("content");
const nav = document.getElementById("nav");
const konto = document.getElementById("konto");

let aktuellerNutzer = null; // { username, ist_admin } wenn angemeldet, sonst null

// ---------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401 && aktuellerNutzer) {
    // Sitzung ist während der Nutzung abgelaufen - zurück zur Anmeldung
    aktuellerNutzer = null;
    zeigeLogin();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Fehler ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Beim Vergleich werden Leerzeichen und Satzzeichen komplett ignoriert,
// nur Buchstaben und Ziffern zählen.
function normalisieren(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function normalisierenCS(s) {
  return (s || "").replace(/[^\p{L}\p{N}]/gu, "");
}

// ---------------------------------------------------------------------
// Sprachausgabe (Web Speech API im Browser)
// ---------------------------------------------------------------------
function sprichWeb(text, lang) {
  if (!("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const stimmen = window.speechSynthesis.getVoices();
  const passend = stimmen.find(v => v.lang === lang) ||
                  stimmen.find(v => v.lang.startsWith(lang.slice(0, 2)));
  if (passend) u.voice = passend;
  window.speechSynthesis.speak(u);
  return true;
}

let ttsFehlerGezeigt = false;
function sprich(text, sprache) {
  if (!text) return;
  const lang = sprache === "en" ? "en-GB" : "de-DE";

  // In der App (Android/iOS): native Sprachausgabe, die WebView-Variante ist dort unzuverlässig
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    try {
      if (!window.nativeTTS) window.nativeTTS = cap.registerPlugin("TextToSpeech");
      window.nativeTTS.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0, category: "playback" })
        .catch((err) => {
          console.error("TTS-Fehler:", err);
          if (!sprichWeb(text, lang) && !ttsFehlerGezeigt) {
            ttsFehlerGezeigt = true;
            alert("Sprachausgabe nicht verfügbar. Bitte in den Android-Einstellungen eine Text-to-Speech-Engine (z.B. Google) mit Deutsch und Englisch installieren.");
          }
        });
      return;
    } catch (e) {
      console.error("TTS-Plugin nicht verfügbar:", e);
    }
  }
  sprichWeb(text, lang);
}

// Legt neben "Weiter" einen Button zum erneuten Anhören an (Taste R, wenn "Weiter" fokussiert ist).
function erzeugeSprechenBtn() {
  const btn = el("button", { class: "secondary" }, "🔊 Nochmal anhören (R)");
  btn.disabled = true;
  return btn;
}

// Fortschrittsbalken (0..1)
function erzeugeProgressbar() {
  return el("div", { class: "progressbar" }, [el("div", { class: "progressbar-fuellung" })]);
}
function progressbarSetzen(bar, anteil) {
  const prozent = Math.max(0, Math.min(1, anteil)) * 100;
  bar.firstChild.style.width = `${prozent}%`;
}

// Eindeutiger (stabiler) Schlüssel einer Vokabel innerhalb einer Lektion, für Fortschritts-Tracking
function vokabelSchluessel(v) {
  return `${v.de}\u241F${v.en}`;
}

// antwortSprache: "en" -> standardmäßig case-sensitive geprüft (außer grossKleinBeachten=false),
// "de" -> immer case-insensitive
function istRichtig(gegeben, korrekt, antwortSprache, grossKleinBeachten = true) {
  const caseSensitiv = antwortSprache === "en" && grossKleinBeachten;
  return caseSensitiv
    ? normalisierenCS(gegeben) === normalisierenCS(korrekt)
    : normalisieren(gegeben) === normalisieren(korrekt);
}

// Mehrere deutsche Wörter/Varianten werden im "Deutsch"-Feld mit ";" getrennt eingegeben.
// Bei der Abfrage/im Test reicht es, eine davon zu nennen.
function deVarianten(deText) {
  return (deText || "").split(";").map(s => s.trim()).filter(Boolean);
}
function deAnzeige(deText) {
  const varianten = deVarianten(deText);
  return varianten.length > 0 ? varianten.join(" / ") : (deText || "");
}

function noteBerechnen(prozent) {
  if (prozent >= 92) return 1;
  if (prozent >= 81) return 2;
  if (prozent >= 67) return 3;
  if (prozent >= 50) return 4;
  if (prozent >= 30) return 5;
  return 6;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setNav(buttons) {
  nav.innerHTML = "";
  for (const b of buttons) nav.appendChild(b);
}

// ---------------------------------------------------------------------
// Startseite: Lektionsliste
// ---------------------------------------------------------------------
// Importiert eine Lektion aus einer JSON-Datei (gleiches Format wie beim Export/auf dem Server:
// { "name": "...", "vokabeln": [{ "de": "...", "en": "..." }, ...] }).
async function lektionImportieren(file) {
  let text;
  try {
    text = await file.text();
  } catch (err) {
    return alert("Datei konnte nicht gelesen werden.");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return alert("Ungültige JSON-Datei.");
  }

  if (!data || !Array.isArray(data.vokabeln)) {
    return alert("Die Datei enthält keine gültige Vokabelliste (Feld \"vokabeln\" fehlt).");
  }

  const vokabeln = data.vokabeln
    .filter(v => v && typeof v.de === "string" && typeof v.en === "string" && v.de.trim() && v.en.trim())
    .map(v => ({
      de: v.de.trim(), en: v.en.trim(),
      satzDe: typeof v.satzDe === "string" ? v.satzDe.trim() : "",
      satzEn: typeof v.satzEn === "string" ? v.satzEn.trim() : "",
    }));
  if (vokabeln.length === 0) {
    return alert("Keine gültigen Vokabelpaare in der Datei gefunden.");
  }
  const gruppe = typeof data.gruppe === "string" ? data.gruppe.trim() : "";

  const vorschlag = (typeof data.name === "string" && data.name.trim()) || file.name.replace(/\.json$/i, "");
  const name = prompt("Name der Lektion:", vorschlag);
  if (!name || !name.trim()) return;

  try {
    const vorhandene = await api("/lektionen");
    if (vorhandene.lektionen.some(l => l.name === name.trim())) {
      if (!confirm(`Lektion "${name.trim()}" existiert bereits. Überschreiben?`)) return;
      await api(`/lektionen/${encodeURIComponent(name.trim())}`, {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), vokabeln, gruppe }),
      });
    } else {
      await api("/lektionen", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), vokabeln, gruppe }),
      });
    }
    zeigeStartseite();
  } catch (err) {
    alert("Fehler beim Importieren: " + err.message);
  }
}

async function zeigeStartseite() {
  renderKontoLeiste();
  setNav([]);
  content.innerHTML = "";

  const neueBtn = el("button", { onclick: () => zeigeLektionErstellen() }, "+ Neue Lektion");
  const importBtn = el("button", { class: "secondary", onclick: () => importFileInput.click() }, "Importieren (JSON)");
  const importFileInput = el("input", { type: "file", accept: ".json,application/json" });
  importFileInput.style.display = "none";
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files[0];
    importFileInput.value = ""; // damit dieselbe Datei erneut ausgewählt werden kann
    if (file) await lektionImportieren(file);
  });
  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "row" }, [neueBtn, importBtn, importFileInput]),
  ]));

  const liste = el("div");
  content.appendChild(liste);

  let daten;
  try {
    daten = await api("/lektionen");
  } catch (err) {
    liste.appendChild(el("p", {}, "Fehler beim Laden: " + err.message));
    return;
  }

  if (daten.lektionen.length === 0) {
    liste.appendChild(el("p", { class: "hinweis" }, "Noch keine Lektionen angelegt."));
    return;
  }

  // Nach Gruppe sortiert zusammenfassen; Lektionen ohne Gruppe kommen gesammelt ans Ende.
  const gruppen = new Map(); // Gruppenname -> Array von Lektionen (ohne Gruppe: Schlüssel "")
  for (const l of daten.lektionen) {
    const g = l.gruppe || "";
    if (!gruppen.has(g)) gruppen.set(g, []);
    gruppen.get(g).push(l);
  }
  const gruppenNamen = [...gruppen.keys()].filter(g => g !== "").sort((a, b) => a.localeCompare(b, "de"));
  if (gruppen.has("")) gruppenNamen.push(""); // "Ohne Gruppe" ans Ende

  function lektionZeile(l) {
    return el("div", { class: "lektion-item" }, [
      el("span", { class: "name" }, l.name),
      el("span", { class: "aktionen" }, [
        el("button", { class: "secondary", onclick: () => zeigeLektionDetail(l.name) }, "Öffnen"),
        el("button", { class: "secondary", onclick: () => lektionLoeschen(l.name) }, "Löschen"),
      ]),
    ]);
  }

  for (const g of gruppenNamen) {
    const lektionenDerGruppe = gruppen.get(g);
    const kopfzeile = [el("h3", {}, g || "Ohne Gruppe")];
    if (g !== "") {
      kopfzeile.push(el("button", {
        class: "secondary",
        onclick: () => starteGruppentest(g, lektionenDerGruppe.map(l => l.name)),
      }, "Gruppentest starten"));
    }
    liste.appendChild(el("div", { class: "row gruppen-kopf" }, kopfzeile));
    for (const l of lektionenDerGruppe) {
      liste.appendChild(lektionZeile(l));
    }
  }
}

// Startet einen Test über die kombinierten Vokabeln aller Lektionen einer Gruppe.
async function starteGruppentest(gruppenname, lektionsnamen) {
  try {
    const alleLektionen = await Promise.all(lektionsnamen.map(n => api(`/lektionen/${encodeURIComponent(n)}`)));
    const kombinierteVokabeln = alleLektionen.flatMap(l => l.vokabeln);
    if (kombinierteVokabeln.length === 0) {
      alert("Diese Gruppe enthält keine Vokabeln.");
      return;
    }
    const virtuelleLektion = { name: `Gruppe: ${gruppenname}`, vokabeln: kombinierteVokabeln };
    await starteTest(virtuelleLektion, () => zeigeStartseite());
  } catch (err) {
    alert("Fehler beim Starten des Gruppentests: " + err.message);
  }
}

async function lektionLoeschen(name) {
  if (!confirm(`Lektion "${name}" wirklich löschen?`)) return;
  await api(`/lektionen/${encodeURIComponent(name)}`, { method: "DELETE" });
  zeigeStartseite();
}

// ---------------------------------------------------------------------
// Lektion erstellen / bearbeiten
// ---------------------------------------------------------------------
function entwurfSchluessel(bestehendeLektion) {
  return `vt_entwurf:${bestehendeLektion ? bestehendeLektion.name : "__neu__"}`;
}
function entwurfLaden(schluessel) {
  try {
    const raw = localStorage.getItem(schluessel);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function entwurfSpeichern(schluessel, daten) {
  try { localStorage.setItem(schluessel, JSON.stringify(daten)); }
  catch (e) { /* z.B. Speicher voll - Autosave ist nur ein Komfortfeature, darf nie crashen */ }
}
function entwurfLoeschen(schluessel) {
  try { localStorage.removeItem(schluessel); } catch (e) { /* ignorieren */ }
}

function zeigeLektionErstellen(bestehendeLektion = null) {
  renderKontoLeiste();
  setNav([el("button", { class: "secondary", onclick: () => zeigeStartseite() }, "← Zurück")]);
  content.innerHTML = "";

  const istBearbeiten = bestehendeLektion !== null;
  const entwurfKey = entwurfSchluessel(bestehendeLektion);
  const entwurf = entwurfLaden(entwurfKey);

  // Fehlende Felder (z.B. aus älteren, ohne Beispielsätze gespeicherten Lektionen) ergänzen
  function normVokabel(v) {
    return { de: v.de || "", en: v.en || "", satzDe: v.satzDe || "", satzEn: v.satzEn || "" };
  }

  let vokabeln = entwurf
    ? entwurf.vokabeln.map(normVokabel)
    : (istBearbeiten ? bestehendeLektion.vokabeln.map(normVokabel) : []);
  let deZuerst = entwurf && typeof entwurf.deZuerst === "boolean" ? entwurf.deZuerst : true;

  const nameInput = el("input", {
    type: "text",
    placeholder: "Name der Lektion",
    value: istBearbeiten ? bestehendeLektion.name : ((entwurf && entwurf.name) || ""),
  });
  if (istBearbeiten) nameInput.disabled = true;

  const gruppenDatalist = el("datalist", { id: "gruppen-vorschlaege" });
  const gruppeInput = el("input", {
    type: "text",
    placeholder: "Gruppe (optional)",
    list: "gruppen-vorschlaege",
    value: entwurf ? (entwurf.gruppe || "") : (istBearbeiten ? (bestehendeLektion.gruppe || "") : ""),
  });
  // Vorhandene Gruppennamen zum Vorschlagen nachladen (tippen geht trotzdem frei weiter)
  api("/lektionen").then(daten => {
    const namen = [...new Set(daten.lektionen.map(l => l.gruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    for (const n of namen) gruppenDatalist.appendChild(el("option", { value: n }));
  }).catch(() => { /* Vorschläge sind nur ein Komfortfeature, kein Problem falls das fehlschlägt */ });

  // Speichert den aktuellen Stand lokal zwischen, damit die Eingabe bei F5 oder
  // abgelaufener Sitzung nicht verloren geht. Wird erst beim erfolgreichen
  // Speichern der Lektion wieder gelöscht.
  function entwurfAktualisieren() {
    entwurfSpeichern(entwurfKey, { name: nameInput.value, vokabeln, deZuerst, gruppe: gruppeInput.value });
  }
  nameInput.addEventListener("input", entwurfAktualisieren);
  gruppeInput.addEventListener("input", entwurfAktualisieren);

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, istBearbeiten ? `Lektion bearbeiten: ${bestehendeLektion.name}` : "Neue Lektion"));

  if (entwurf) {
    card.appendChild(el("p", { class: "hinweis" }, "Nicht gespeicherte Eingabe von zuvor wurde wiederhergestellt."));
    card.appendChild(el("div", { class: "row" }, [
      el("button", {
        class: "secondary",
        onclick: () => { entwurfLoeschen(entwurfKey); zeigeLektionErstellen(bestehendeLektion); },
      }, "Entwurf verwerfen"),
    ]));
  }

  card.appendChild(el("div", { class: "row" }, [nameInput]));
  card.appendChild(el("div", { class: "row" }, [gruppeInput, gruppenDatalist]));

  const vokabelListe = el("div", { class: "vokabel-liste" });

  const reihenfolgeBtn = el("button", {
    class: "secondary",
    onclick: () => {
      deZuerst = !deZuerst;
      renderVokabelListe();
      reihenfolgeBtn.textContent = reihenfolgeText();
      entwurfAktualisieren();
    },
  }, "");
  function reihenfolgeText() {
    return deZuerst ? "⇄ Reihenfolge: Deutsch → Englisch" : "⇄ Reihenfolge: Englisch → Deutsch";
  }
  reihenfolgeBtn.textContent = reihenfolgeText();
  card.appendChild(el("div", { class: "row" }, [reihenfolgeBtn]));
  card.appendChild(vokabelListe);

  let fokusIndex = null; // Index der Zeile, deren erstes Feld nach dem Rendern fokussiert werden soll

  function neueZeileAnhaengen() {
    vokabeln.push({ de: "", en: "", satzDe: "", satzEn: "" });
    fokusIndex = vokabeln.length - 1;
    renderVokabelListe();
    entwurfAktualisieren();
  }

  function renderVokabelListe() {
    vokabelListe.innerHTML = "";
    vokabeln.forEach((v, i) => {
      const istLetzte = i === vokabeln.length - 1;
      const zeile = el("div", { class: "vokabel-zeile" });

      // erstesFeld/zweitesFeld bestimmen sich aus der gewählten Reihenfolge,
      // die Daten (v.de / v.en) bleiben davon unberührt.
      const erstesKey = deZuerst ? "de" : "en";
      const zweitesKey = deZuerst ? "en" : "de";
      const erstesPlatzhalter = deZuerst ? "Deutsch (ggf. mehrere mit ; trennen)" : "Englisch";
      const zweitesPlatzhalter = deZuerst ? "Englisch" : "Deutsch (ggf. mehrere mit ; trennen)";

      const erstesInput = el("input", { type: "text", placeholder: erstesPlatzhalter, value: v[erstesKey] });
      const zweitesInput = el("input", { type: "text", placeholder: zweitesPlatzhalter, value: v[zweitesKey] });
      erstesInput.addEventListener("input", () => { v[erstesKey] = erstesInput.value; entwurfAktualisieren(); });
      zweitesInput.addEventListener("input", () => { v[zweitesKey] = zweitesInput.value; entwurfAktualisieren(); });

      // Optionale Beispielsätze, werden bei der Abfrage passend zur Abfragerichtung mit angezeigt
      const satzDeInput = el("input", { type: "text", placeholder: "Beispielsatz Deutsch (optional)", value: v.satzDe });
      const satzEnInput = el("input", { type: "text", placeholder: "Beispielsatz Englisch (optional)", value: v.satzEn });
      satzDeInput.addEventListener("input", () => { v.satzDe = satzDeInput.value; entwurfAktualisieren(); });
      satzEnInput.addEventListener("input", () => { v.satzEn = satzEnInput.value; entwurfAktualisieren(); });

      // Enter wandert der Reihe nach durch die Felder derselben Zeile
      erstesInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); zweitesInput.focus(); }
      });
      zweitesInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); satzDeInput.focus(); }
      });
      satzDeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); satzEnInput.focus(); }
      });

      // In der letzten Zeile: Tab oder Enter im letzten Feld (Beispielsatz Englisch) legt
      // automatisch eine neue, leere Vokabelzeile an und springt dorthin (kein Mausklick nötig).
      // Nur wenn das Wortpaar bereits ausgefüllt ist - die Beispielsätze sind optional und
      // müssen dafür nicht gefüllt sein. Sonst normal weiter tabben (z.B. zum Speichern-Button).
      function ggfNeueZeile(e) {
        const wortpaarAusgefuellt = erstesInput.value.trim() !== "" && zweitesInput.value.trim() !== "";
        if (istLetzte && wortpaarAusgefuellt) {
          e.preventDefault();
          neueZeileAnhaengen();
        }
      }
      satzEnInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); ggfNeueZeile(e); }
        else if (e.key === "Tab" && !e.shiftKey) { ggfNeueZeile(e); }
      });

      const entfernenBtn = el("button", {
        class: "secondary", tabindex: "-1",
        onclick: () => { vokabeln.splice(i, 1); renderVokabelListe(); entwurfAktualisieren(); },
      }, "✕");
      zeile.appendChild(el("div", { class: "row" }, [erstesInput, zweitesInput, entfernenBtn]));
      zeile.appendChild(el("div", { class: "row" }, [satzDeInput, satzEnInput]));
      vokabelListe.appendChild(zeile);

      if (fokusIndex === i) {
        fokusIndex = null;
        requestAnimationFrame(() => erstesInput.focus());
      }
    });
  }
  renderVokabelListe();

  const hinzufuegenBtn = el("button", {
    class: "secondary",
    onclick: () => neueZeileAnhaengen(),
  }, "+ Vokabel hinzufügen");

  card.appendChild(el("div", { class: "row" }, [hinzufuegenBtn]));

  const speichernBtn = el("button", {
    onclick: async () => {
      const name = nameInput.value.trim();
      const bereinigt = vokabeln
        .map(v => ({
          de: v.de.trim(), en: v.en.trim(),
          satzDe: (v.satzDe || "").trim(), satzEn: (v.satzEn || "").trim(),
        }))
        .filter(v => v.de && v.en);

      const gruppe = gruppeInput.value.trim();

      if (!name) return alert("Bitte einen Namen für die Lektion angeben.");
      if (bereinigt.length === 0) return alert("Bitte mindestens eine vollständige Vokabel eingeben.");

      try {
        if (istBearbeiten) {
          await api(`/lektionen/${encodeURIComponent(name)}`, {
            method: "PUT",
            body: JSON.stringify({ name, vokabeln: bereinigt, gruppe }),
          });
        } else {
          await api("/lektionen", {
            method: "POST",
            body: JSON.stringify({ name, vokabeln: bereinigt, gruppe }),
          });
        }
        entwurfLoeschen(entwurfKey);
        zeigeStartseite();
      } catch (err) {
        alert("Fehler: " + err.message);
      }
    },
  }, "Speichern");

  card.appendChild(el("div", { class: "row" }, [speichernBtn]));
  content.appendChild(card);
  if (vokabeln.length === 0) { vokabeln.push({ de: "", en: "", satzDe: "", satzEn: "" }); renderVokabelListe(); }
}

// ---------------------------------------------------------------------
// Lektion-Detailseite: Aktionen wählen
// ---------------------------------------------------------------------
async function zeigeLektionDetail(name) {
  renderKontoLeiste();
  setNav([el("button", { class: "secondary", onclick: () => zeigeStartseite() }, "← Zurück")]);
  content.innerHTML = "";

  let lektion;
  try {
    lektion = await api(`/lektionen/${encodeURIComponent(name)}`);
  } catch (err) {
    content.appendChild(el("p", {}, "Fehler: " + err.message));
    return;
  }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, lektion.name));
  card.appendChild(el("p", { class: "hinweis" }, `${lektion.vokabeln.length} Vokabeln`));

  const grossKleinCheckbox = el("input", { type: "checkbox", id: "gross-klein" });
  grossKleinCheckbox.checked = true; // Standard: aktiviert
  const grossKleinLabel = el("label", { for: "gross-klein" }, " Groß-/Kleinschreibung beachten (bei Englisch-Antworten, nur Abfrage)");
  card.appendChild(el("div", { class: "row" }, [grossKleinCheckbox, grossKleinLabel]));

  card.appendChild(el("div", { class: "row" }, [
    el("button", { onclick: () => starteAbfrage(lektion, "de-en", grossKleinCheckbox.checked) }, "Abfragen: Deutsch → Englisch"),
  ]));
  card.appendChild(el("div", { class: "row" }, [
    el("button", { onclick: () => starteAbfrage(lektion, "en-de", grossKleinCheckbox.checked) }, "Abfragen: Englisch → Deutsch"),
  ]));
  card.appendChild(el("div", { class: "row" }, [
    el("button", { onclick: () => starteTest(lektion) }, "Test starten"),
  ]));
  card.appendChild(el("div", { class: "row" }, [
    el("button", { onclick: () => starteDiktat(lektion) }, "🔊 Diktat starten"),
  ]));
  card.appendChild(el("div", { class: "row" }, [
    el("button", { class: "secondary", onclick: () => zeigeLektionErstellen(lektion) }, "Vokabeln bearbeiten"),
    el("button", { class: "secondary", onclick: () => lektionExportieren(lektion) }, "Exportieren (JSON)"),
  ]));

  content.appendChild(card);
}

// Lädt die Lektion genau im gespeicherten Format ({ name, vokabeln: [{de, en}, ...] })
// als JSON-Datei herunter.
function lektionExportieren(lektion) {
  const data = { name: lektion.name, vokabeln: lektion.vokabeln, gruppe: lektion.gruppe || "" };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `${lektion.name}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
// Abfrage-Modus (eine Richtung, falsche werden am Ende wiederholt)
// ---------------------------------------------------------------------
function starteAbfrage(lektion, richtung, grossKleinBeachten = true) {
  renderKontoLeiste();
  setNav([el("button", { class: "secondary", onclick: () => zeigeLektionDetail(lektion.name) }, "← Abbrechen (Fortschritt bleibt erhalten)")]);

  const sitzungKey = `vt_abfrage:${lektion.name}:${richtung}`;
  const gespeichert = entwurfLaden(sitzungKey);
  const gesamtAnzahl = lektion.vokabeln.length;

  let rundenNr = gespeichert ? gespeichert.rundenNr : 1;
  let alleErgebnisse = gespeichert ? gespeichert.alleErgebnisse : [];
  let nochOffen = new Set(gespeichert ? gespeichert.nochOffen : lektion.vokabeln.map(vokabelSchluessel));
  let zeigeFortgesetztHinweis = !!gespeichert;

  // Frage: das, was angezeigt wird (bei mehreren deutschen Varianten alle, durch " / " getrennt)
  function frageText(v) { return richtung === "de-en" ? deAnzeige(v.de) : v.en; }
  // Anzeige der Lösung im Feedback ("Falsch. Richtig wäre: ...") - ebenfalls alle Varianten
  function antwortAnzeige(v) { return richtung === "de-en" ? v.en : deAnzeige(v.de); }
  // Zum Vorlesen reicht eine (die erste) Variante
  // Beim Auflösen alle deutschen Varianten vorlesen, nicht nur die erste
  function sprechWort(v) { return richtung === "de-en" ? v.en : (deVarianten(v.de).join(", ") || v.de); }
  // Beispielsatz passend zur Abfragerichtung (DE->EN: deutscher Satz, EN->DE: englischer Satz)
  function beispielsatz(v) { return richtung === "de-en" ? v.satzDe : v.satzEn; }
  // Prüfung: bei mehreren deutschen Varianten reicht es, eine davon zu treffen
  function pruefeAntwort(gegeben, v) {
    if (richtung === "de-en") return istRichtig(gegeben, v.en, "en", grossKleinBeachten);
    return deVarianten(v.de).some(alt => istRichtig(gegeben, alt, "de", grossKleinBeachten));
  }

  function sitzungSichern(vokabelListe, index, falscheDieserRunde) {
    entwurfSpeichern(sitzungKey, {
      rundenNr, runde: vokabelListe, index, falscheDieserRunde,
      alleErgebnisse, nochOffen: [...nochOffen],
    });
  }

  function naechsteRunde(vokabelListe, runde, startIndex = 0, falscheVorab = []) {
    let index = startIndex;
    let falscheDieserRunde = falscheVorab.slice();

    function zeigeFrage() {
      content.innerHTML = "";
      if (index >= vokabelListe.length) {
        if (falscheDieserRunde.length > 0) {
          rundenNr++;
          naechsteRunde(shuffle(falscheDieserRunde), rundenNr);
        } else {
          entwurfLoeschen(sitzungKey);
          abfrageAbschluss();
        }
        return;
      }

      sitzungSichern(vokabelListe, index, falscheDieserRunde);

      if (zeigeFortgesetztHinweis) {
        zeigeFortgesetztHinweis = false;
        content.appendChild(el("div", { class: "card" }, [
          el("p", { class: "hinweis" }, "Fortgesetzt von einer unterbrochenen Abfrage."),
          el("button", {
            class: "secondary",
            onclick: () => { entwurfLoeschen(sitzungKey); starteAbfrage(lektion, richtung, grossKleinBeachten); },
          }, "Stattdessen neu starten"),
        ]));
      }

      const v = vokabelListe[index];
      const box = el("div", { class: "frage-box card" });

      const progressbar = erzeugeProgressbar();
      progressbarSetzen(progressbar, (gesamtAnzahl - nochOffen.size) / gesamtAnzahl);
      box.appendChild(progressbar);

      box.appendChild(el("div", { class: "fortschritt" },
        `Runde ${runde} · Frage ${index + 1} / ${vokabelListe.length}` +
        (runde > 1 ? " (Wiederholung der Fehler)" : "")
      ));
      box.appendChild(el("div", { class: "wort" }, frageText(v)));
      const satz = beispielsatz(v);
      if (satz && satz.trim()) {
        box.appendChild(el("div", { class: "beispielsatz" }, satz.trim()));
      }

      const input = el("input", { type: "text", class: "antwort-input" });
      const feedback = el("div", { class: "feedback" });
      box.appendChild(input);
      box.appendChild(feedback);

      const weiterBtn = el("button", { onclick: () => weiter() }, "Prüfen");
      const sprechenBtn = erzeugeSprechenBtn();
      box.appendChild(el("div", { class: "row" }, [weiterBtn, sprechenBtn]));
      content.appendChild(box);
      input.focus();

      let ausgewertet = false;
      function auswerten() {
        if (ausgewertet) return;
        ausgewertet = true;
        const antwortSprache = richtung === "de-en" ? "en" : "de";
        const richtig = pruefeAntwort(input.value, v);
        input.disabled = true;
        weiterBtn.textContent = "Weiter";
        const sprechen = () => sprich(sprechWort(v), antwortSprache);
        sprechenBtn.disabled = false;
        sprechenBtn.onclick = sprechen;
        weiterBtn.addEventListener("keydown", (e) => {
          if (e.key.toLowerCase() === "r") { e.preventDefault(); sprechen(); }
        });
        if (richtig) {
          feedback.textContent = "Richtig!";
          feedback.className = "feedback richtig";
          nochOffen.delete(vokabelSchluessel(v));
        } else {
          feedback.textContent = `Falsch. Richtig wäre: ${antwortAnzeige(v)}`;
          feedback.className = "feedback falsch";
          falscheDieserRunde.push(v);
        }
        sprechen(); // Wort nach der Anzeige von richtig/falsch vorlesen
        alleErgebnisse.push({ de: v.de, en: v.en, richtung, gegeben: input.value, richtig });
        sitzungSichern(vokabelListe, index, falscheDieserRunde);
        // Fokuswechsel erst nach dem aktuellen Tastendruck, sonst löst derselbe
        // Enter-Druck sofort auch den fokussierten Button aus.
        setTimeout(() => weiterBtn.focus(), 0);
      }

      function weiter() {
        if (!ausgewertet) { auswerten(); return; }
        index++;
        zeigeFrage();
      }

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); weiter(); }
      });
    }

    zeigeFrage();
  }

  async function abfrageAbschluss() {
    content.innerHTML = "";
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", {}, "Abfrage beendet"));
    card.appendChild(el("p", {}, `Es wurden ${lektion.vokabeln.length} Vokabeln abgefragt, ` +
      `${alleErgebnisse.filter(e=>e.richtig).length} von ${alleErgebnisse.length} Antworten waren beim ersten oder wiederholten Versuch richtig.`));
    card.appendChild(el("button", { onclick: () => zeigeLektionDetail(lektion.name) }, "Zurück zur Lektion"));
    content.appendChild(card);

    try {
      await api("/log/abfrage", {
        method: "POST",
        body: JSON.stringify({ lektion: lektion.name, richtung, ergebnisse: alleErgebnisse }),
      });
    } catch (err) {
      console.error("Logging fehlgeschlagen:", err);
    }
  }

  const startRunde = gespeichert ? gespeichert.runde : shuffle(lektion.vokabeln);
  const startIndex = gespeichert ? gespeichert.index : 0;
  const startFalsche = gespeichert ? gespeichert.falscheDieserRunde : [];
  naechsteRunde(startRunde, rundenNr, startIndex, startFalsche);
}

// ---------------------------------------------------------------------
// Test-Modus (beide Richtungen, falsche werden nicht wiederholt, Note am Ende)
// ---------------------------------------------------------------------
// zurueck: optionaler Callback für "Abbrechen"/"Zurück zur Lektion" - Standard: zurück zur
// Lektion-Detailseite. Für Gruppentests (keine einzelne Lektion) wird stattdessen z.B. die
// Startseite übergeben.
async function starteTest(lektion, zurueck = null) {
  if (!zurueck) zurueck = () => zeigeLektionDetail(lektion.name);
  renderKontoLeiste();
  let timerInterval = null;
  setNav([el("button", {
    class: "secondary",
    onclick: () => { if (timerInterval) clearInterval(timerInterval); zurueck(); },
  }, "← Abbrechen (Fortschritt bleibt erhalten)")]);
  content.innerHTML = "";
  content.appendChild(el("p", { class: "hinweis" }, "Lade …"));

  const sitzungKey = `vt_test:${lektion.name}`;
  const gespeichert = entwurfLaden(sitzungKey);
  const gesamtFragenAnzahl = lektion.vokabeln.length * 2;

  let zeitlimitSekunden;
  let startZeitMs;
  if (gespeichert && typeof gespeichert.zeitlimitSekunden === "number") {
    zeitlimitSekunden = gespeichert.zeitlimitSekunden;
    startZeitMs = gespeichert.startZeitMs;
  } else {
    let sekundenProVokabel = 15;
    try {
      const einst = await api("/einstellungen");
      if (typeof einst.sekunden_pro_vokabel === "number") sekundenProVokabel = einst.sekunden_pro_vokabel;
    } catch (err) { /* Standardwert verwenden, falls Einstellung nicht abrufbar */ }
    zeitlimitSekunden = sekundenProVokabel * gesamtFragenAnzahl;
    startZeitMs = Date.now();
  }

  let fragen = gespeichert ? gespeichert.fragen : shuffle([
    ...lektion.vokabeln.map(v => ({ ...v, richtung: "de-en" })),
    ...lektion.vokabeln.map(v => ({ ...v, richtung: "en-de" })),
  ]);
  let uebersprungen = gespeichert ? gespeichert.uebersprungen : [];
  let ergebnisse = gespeichert ? gespeichert.ergebnisse : [];
  let index = gespeichert ? gespeichert.index : 0;
  let inNachholRunde = gespeichert ? gespeichert.inNachholRunde : false;
  let zeigeFortgesetztHinweis = !!gespeichert;
  let zeitAnzeigeEl = null;
  let testBeendet = false;

  function frageText(f) { return f.richtung === "de-en" ? deAnzeige(f.de) : f.en; }
  function antwortAnzeige(f) { return f.richtung === "de-en" ? f.en : deAnzeige(f.de); }
  // Beim Auflösen alle deutschen Varianten vorlesen, nicht nur die erste
  function sprechWort(f) { return f.richtung === "de-en" ? f.en : (deVarianten(f.de).join(", ") || f.de); }
  function pruefeAntwort(gegeben, f) {
    if (f.richtung === "de-en") return istRichtig(gegeben, f.en, "en");
    return deVarianten(f.de).some(alt => istRichtig(gegeben, alt, "de"));
  }

  function sitzungSichern() {
    entwurfSpeichern(sitzungKey, { fragen, uebersprungen, ergebnisse, index, inNachholRunde, zeitlimitSekunden, startZeitMs });
  }

  function timerAktualisieren() {
    if (testBeendet) return;
    const verbleibend = zeitlimitSekunden - Math.floor((Date.now() - startZeitMs) / 1000);
    if (verbleibend <= 0) {
      clearInterval(timerInterval);
      zeitAbgelaufen();
      return;
    }
    if (zeitAnzeigeEl) {
      const min = Math.floor(verbleibend / 60);
      const sek = String(verbleibend % 60).padStart(2, "0");
      zeitAnzeigeEl.textContent = `Verbleibende Zeit: ${min}:${sek}`;
      zeitAnzeigeEl.className = "zeitlimit" + (verbleibend <= 30 ? " knapp" : "");
    }
  }

  function zeigeFrage() {
    content.innerHTML = "";

    if (!inNachholRunde && index >= fragen.length) {
      if (uebersprungen.length > 0) {
        fragen = shuffle(uebersprungen);
        uebersprungen = [];
        index = 0;
        inNachholRunde = true;
      } else {
        testBeendet = true;
        clearInterval(timerInterval);
        entwurfLoeschen(sitzungKey);
        testAbschluss();
        return;
      }
    } else if (inNachholRunde && index >= fragen.length) {
      testBeendet = true;
      clearInterval(timerInterval);
      entwurfLoeschen(sitzungKey);
      testAbschluss();
      return;
    }

    sitzungSichern();

    if (zeigeFortgesetztHinweis) {
      zeigeFortgesetztHinweis = false;
      content.appendChild(el("div", { class: "card" }, [
        el("p", { class: "hinweis" }, "Fortgesetzt von einem unterbrochenen Test (Zeitlimit läuft unverändert weiter)."),
        el("button", {
          class: "secondary",
          onclick: () => { clearInterval(timerInterval); entwurfLoeschen(sitzungKey); starteTest(lektion, zurueck); },
        }, "Stattdessen neu starten"),
      ]));
    }

    const f = fragen[index];
    const box = el("div", { class: "frage-box card" });

    const progressbar = erzeugeProgressbar();
    progressbarSetzen(progressbar, ergebnisse.length / gesamtFragenAnzahl);
    box.appendChild(progressbar);

    zeitAnzeigeEl = el("div", { class: "zeitlimit" }, "");
    box.appendChild(zeitAnzeigeEl);
    timerAktualisieren();

    box.appendChild(el("div", { class: "fortschritt" },
      `Test · Frage ${ergebnisse.length + 1} / ${gesamtFragenAnzahl}` + (inNachholRunde ? " (übersprungene Vokabeln)" : "")
    ));
    box.appendChild(el("div", { class: "wort" }, frageText(f)));

    const input = el("input", { type: "text", class: "antwort-input" });
    const feedback = el("div", { class: "feedback" });
    box.appendChild(input);
    box.appendChild(feedback);

    const weiterBtn = el("button", { onclick: () => weiter() }, "Prüfen");
    const sprechenBtn = erzeugeSprechenBtn();
    const buttons = [weiterBtn, sprechenBtn];
    if (!inNachholRunde) {
      buttons.push(el("button", { class: "secondary", onclick: () => ueberspringen() }, "Überspringen"));
    }
    box.appendChild(el("div", { class: "row" }, buttons));
    content.appendChild(box);
    input.focus();

    function ueberspringen() {
      uebersprungen.push(f);
      index++;
      sitzungSichern();
      zeigeFrage();
    }

    let ausgewertet = false;
    function auswerten() {
      if (ausgewertet) return;
      ausgewertet = true;
      const antwortSprache = f.richtung === "de-en" ? "en" : "de";
      const richtig = pruefeAntwort(input.value, f);
      input.disabled = true;
      weiterBtn.textContent = "Weiter";
      const sprechen = () => sprich(sprechWort(f), antwortSprache);
      sprechenBtn.disabled = false;
      sprechenBtn.onclick = sprechen;
      weiterBtn.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() === "r") { e.preventDefault(); sprechen(); }
      });
      if (richtig) {
        feedback.textContent = "Richtig!";
        feedback.className = "feedback richtig";
      } else {
        feedback.textContent = `Falsch. Richtig wäre: ${antwortAnzeige(f)}`;
        feedback.className = "feedback falsch";
      }
      sprechen(); // Wort nach der Anzeige von richtig/falsch vorlesen
      ergebnisse.push({ de: f.de, en: f.en, richtung: f.richtung, gegeben: input.value, richtig });
      sitzungSichern();
      // Fokuswechsel erst nach dem aktuellen Tastendruck, sonst löst derselbe
      // Enter-Druck sofort auch den fokussierten Button aus.
      setTimeout(() => weiterBtn.focus(), 0);
    }

    function weiter() {
      if (!ausgewertet) { auswerten(); return; }
      index++;
      zeigeFrage();
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); weiter(); }
    });
  }

  function zeitAbgelaufen() {
    testBeendet = true;
    const unbeantwortet = [...fragen.slice(index), ...uebersprungen];
    for (const f of unbeantwortet) {
      ergebnisse.push({ de: f.de, en: f.en, richtung: f.richtung, gegeben: "", richtig: false });
    }
    entwurfLoeschen(sitzungKey);
    testAbschluss(true);
  }

  async function testAbschluss(durchZeitablauf = false) {
    const punkte = ergebnisse.filter(e => e.richtig).length;
    const maxPunkte = ergebnisse.length;
    const prozent = maxPunkte > 0 ? (punkte / maxPunkte) * 100 : 0;
    const note = noteBerechnen(prozent);

    content.innerHTML = "";
    const card = el("div", { class: "card" });
    card.appendChild(el("h2", {}, "Test beendet"));
    if (durchZeitablauf) {
      card.appendChild(el("p", { class: "hinweis" }, "Das Zeitlimit ist abgelaufen - verbleibende Fragen wurden als falsch gewertet."));
    }
    card.appendChild(el("div", { class: "ergebnis-note" }, `Note ${note}`));
    card.appendChild(el("p", {}, `${punkte} von ${maxPunkte} Punkten (${prozent.toFixed(1)} %)`));

    const tabelle = el("table", { class: "ergebnis-tabelle" });
    tabelle.appendChild(el("tr", {}, [
      el("th", {}, "Deutsch"), el("th", {}, "Englisch"), el("th", {}, "Richtung"),
      el("th", {}, "Deine Antwort"), el("th", {}, "Ergebnis"),
    ]));
    for (const e of ergebnisse) {
      tabelle.appendChild(el("tr", {}, [
        el("td", {}, e.de), el("td", {}, e.en),
        el("td", {}, e.richtung === "de-en" ? "DE→EN" : "EN→DE"),
        el("td", {}, e.gegeben || "–"),
        el("td", { class: e.richtig ? "tag-richtig" : "tag-falsch" }, e.richtig ? "richtig" : "falsch"),
      ]));
    }
    card.appendChild(tabelle);
    card.appendChild(el("div", { class: "row" }, [
      el("button", { onclick: () => zurueck() }, "Zurück zur Lektion"),
    ]));
    content.appendChild(card);

    try {
      await api("/log/test", {
        method: "POST",
        body: JSON.stringify({
          lektion: lektion.name, ergebnisse, punkte, max_punkte: maxPunkte, prozent, note,
        }),
      });
    } catch (err) {
      console.error("Logging fehlgeschlagen:", err);
    }
  }

  timerInterval = setInterval(timerAktualisieren, 1000);
  zeigeFrage();
}

// ---------------------------------------------------------------------
// Diktat: deutsche Wörter werden der Reihe nach vorgelesen, der zeitliche
// Abstand zwischen den Wörtern entspricht der Admin-Einstellung "Sekunden
// pro Vokabel" (derselbe Wert wie für das Test-Zeitlimit). Während des
// Vorlesens wird das Wort selbst nicht angezeigt (Diktat zum Mitschreiben);
// am Ende gibt es eine Liste zum Selbst-Kontrollieren.
// ---------------------------------------------------------------------
async function starteDiktat(lektion) {
  renderKontoLeiste();
  let timeoutId = null;
  setNav([el("button", {
    class: "secondary",
    onclick: () => { if (timeoutId) clearTimeout(timeoutId); zeigeLektionDetail(lektion.name); },
  }, "← Beenden")]);
  content.innerHTML = "";
  content.appendChild(el("p", { class: "hinweis" }, "Lade …"));

  let sekundenProVokabel = 15;
  try {
    const einst = await api("/einstellungen");
    if (typeof einst.sekunden_pro_vokabel === "number") sekundenProVokabel = einst.sekunden_pro_vokabel;
  } catch (err) { /* Standardwert verwenden, falls Einstellung nicht abrufbar */ }
  const abstandMs = sekundenProVokabel * 1000;

  const woerter = lektion.vokabeln.map(v => deVarianten(v.de).join(", ") || v.de); // der Reihe nach, wie in der Lektion angelegt
  let index = 0;
  let pausiert = false;

  content.innerHTML = "";
  const box = el("div", { class: "frage-box card" });
  const progressbar = erzeugeProgressbar();
  box.appendChild(progressbar);
  const fortschrittText = el("div", { class: "fortschritt" }, "");
  box.appendChild(fortschrittText);
  box.appendChild(el("div", { class: "wort" }, "🔊"));
  box.appendChild(el("p", { class: "hinweis" }, `Abstand zwischen den Wörtern: ${sekundenProVokabel} s (Admin-Einstellung, wie beim Test-Zeitlimit)`));

  const pauseBtn = el("button", { class: "secondary", onclick: () => pauseUmschalten() }, "Pause");
  const beendenBtn = el("button", { class: "secondary", onclick: () => { if (timeoutId) clearTimeout(timeoutId); zeigeLektionDetail(lektion.name); } }, "Beenden");
  box.appendChild(el("div", { class: "row" }, [pauseBtn, beendenBtn]));
  content.appendChild(box);

  function pauseUmschalten() {
    pausiert = !pausiert;
    pauseBtn.textContent = pausiert ? "Fortsetzen" : "Pause";
    if (pausiert && timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    } else if (!pausiert) {
      naechstesWort();
    }
  }

  function naechstesWort() {
    if (index >= woerter.length) {
      diktatFertig();
      return;
    }
    progressbarSetzen(progressbar, index / woerter.length);
    fortschrittText.textContent = `Wort ${index + 1} / ${woerter.length}`;
    sprich(woerter[index], "de");
    index++;
    if (!pausiert) {
      timeoutId = setTimeout(naechstesWort, abstandMs);
    }
  }

  function diktatFertig() {
    progressbarSetzen(progressbar, 1);
    content.innerHTML = "";
    const abschlussCard = el("div", { class: "card" });
    abschlussCard.appendChild(el("h2", {}, "Diktat beendet"));
    abschlussCard.appendChild(el("p", {}, `${woerter.length} Wörter wurden vorgelesen.`));

    const anzeigenBtn = el("button", {
      class: "secondary",
      onclick: () => {
        anzeigenBtn.disabled = true;
        const liste = el("div");
        lektion.vokabeln.forEach((v, i) => {
          liste.appendChild(el("div", { class: "lektion-item" }, [
            el("span", {}, `${i + 1}. ${deAnzeige(v.de)}`),
            el("span", {}, v.en),
          ]));
        });
        abschlussCard.appendChild(liste);
      },
    }, "Wörter zum Kontrollieren anzeigen");
    abschlussCard.appendChild(el("div", { class: "row" }, [anzeigenBtn]));
    abschlussCard.appendChild(el("div", { class: "row" }, [
      el("button", { onclick: () => zeigeLektionDetail(lektion.name) }, "Zurück zur Lektion"),
    ]));
    content.appendChild(abschlussCard);
  }

  naechstesWort();
}

// ---------------------------------------------------------------------
// Konto-Leiste (Benutzername, Abmelden, ggf. Admin-Bereich) - persistent
// außerhalb von #content, wird am Anfang jeder Ansicht neu gezeichnet.
// ---------------------------------------------------------------------
function renderKontoLeiste() {
  konto.innerHTML = "";
  if (!aktuellerNutzer) return;
  const info = el("span", { class: "hinweis" }, `Angemeldet als ${aktuellerNutzer.username}`);
  const abmeldenBtn = el("button", {
    class: "secondary",
    onclick: async () => {
      try { await api("/auth/logout", { method: "POST" }); } catch (err) { /* egal, lokal trotzdem abmelden */ }
      aktuellerNutzer = null;
      zeigeLogin();
    },
  }, "Abmelden");
  const buttons = [info, abmeldenBtn];
  if (aktuellerNutzer.ist_admin) {
    buttons.push(el("button", { class: "secondary", onclick: () => zeigeAdmin() }, "Admin-Bereich"));
  }
  konto.appendChild(el("div", { class: "row" }, buttons));
}

// ---------------------------------------------------------------------
// Anmelden / Registrieren
// ---------------------------------------------------------------------
function zeigeLogin() {
  konto.innerHTML = "";
  setNav([]);
  content.innerHTML = "";

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "Anmelden"));
  const userInput = el("input", { type: "text", placeholder: "Benutzername" });
  const pwInput = el("input", { type: "password", placeholder: "Passwort" });
  const fehler = el("p", { class: "hinweis" }, "");
  card.appendChild(el("div", { class: "row" }, [userInput]));
  card.appendChild(el("div", { class: "row" }, [pwInput]));
  card.appendChild(fehler);

  async function anmelden() {
    fehler.textContent = "";
    try {
      const res = await fetch(API + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: userInput.value.trim(), passwort: pwInput.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Fehler ${res.status}`);
      }
      aktuellerNutzer = await res.json();
      renderKontoLeiste();
      zeigeStartseite();
    } catch (err) {
      fehler.textContent = err.message;
    }
  }

  const anmeldenBtn = el("button", { onclick: anmelden }, "Anmelden");
  card.appendChild(el("div", { class: "row" }, [anmeldenBtn]));
  card.appendChild(el("div", { class: "row" }, [
    el("button", { class: "secondary", onclick: () => zeigeRegister() }, "Noch kein Konto? Registrieren"),
  ]));
  content.appendChild(card);

  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") anmelden(); });
  userInput.addEventListener("keydown", (e) => { if (e.key === "Enter") pwInput.focus(); });
  userInput.focus();
}

function zeigeRegister() {
  konto.innerHTML = "";
  setNav([el("button", { class: "secondary", onclick: () => zeigeLogin() }, "← Zur Anmeldung")]);
  content.innerHTML = "";

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "Registrieren"));
  const userInput = el("input", { type: "text", placeholder: "Benutzername (3-32 Zeichen, Buchstaben/Ziffern/_/-)" });
  const pwInput = el("input", { type: "password", placeholder: "Passwort (mind. 6 Zeichen)" });
  const pw2Input = el("input", { type: "password", placeholder: "Passwort wiederholen" });
  const fehler = el("p", { class: "hinweis" }, "");
  card.appendChild(el("div", { class: "row" }, [userInput]));
  card.appendChild(el("div", { class: "row" }, [pwInput]));
  card.appendChild(el("div", { class: "row" }, [pw2Input]));
  card.appendChild(fehler);

  async function registrieren() {
    fehler.textContent = "";
    if (pwInput.value !== pw2Input.value) {
      fehler.textContent = "Passwörter stimmen nicht überein.";
      return;
    }
    try {
      const res = await fetch(API + "/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: userInput.value.trim(), passwort: pwInput.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Fehler ${res.status}`);
      }
      aktuellerNutzer = await res.json();
      renderKontoLeiste();
      zeigeStartseite();
    } catch (err) {
      fehler.textContent = err.message;
    }
  }

  const registrierenBtn = el("button", { onclick: registrieren }, "Registrieren");
  card.appendChild(el("div", { class: "row" }, [registrierenBtn]));
  content.appendChild(card);

  pw2Input.addEventListener("keydown", (e) => { if (e.key === "Enter") registrieren(); });
  userInput.focus();
}

// ---------------------------------------------------------------------
// Admin-Bereich: Benutzer auflisten und entfernen
// ---------------------------------------------------------------------
async function zeigeAdmin() {
  renderKontoLeiste();
  setNav([el("button", { class: "secondary", onclick: () => zeigeStartseite() }, "← Zurück")]);
  content.innerHTML = "";

  // Zeitlimit-Einstellung (Basis für das Test-Zeitlimit: Sekunden je abzufragender Vokabel)
  const einstellungenCard = el("div", { class: "card" });
  einstellungenCard.appendChild(el("h2", {}, "Einstellungen"));
  const zeitlimitInput = el("input", { type: "text", placeholder: "Sekunden pro Vokabel" });
  const zeitlimitHinweis = el("p", { class: "hinweis" }, "");
  einstellungenCard.appendChild(el("div", { class: "row" }, [
    el("label", { for: "zeitlimit-input" }, "Zeitlimit beim Test: Sekunden je Vokabel "),
    zeitlimitInput,
  ]));
  einstellungenCard.appendChild(zeitlimitHinweis);
  const zeitlimitSpeichernBtn = el("button", {
    onclick: async () => {
      const wert = parseInt(zeitlimitInput.value, 10);
      if (!Number.isInteger(wert) || wert < 1 || wert > 600) {
        zeitlimitHinweis.textContent = "Bitte eine ganze Zahl zwischen 1 und 600 eingeben.";
        return;
      }
      try {
        await api("/admin/einstellungen", { method: "PUT", body: JSON.stringify({ sekunden_pro_vokabel: wert }) });
        zeitlimitHinweis.textContent = "Gespeichert.";
      } catch (err) {
        zeitlimitHinweis.textContent = "Fehler: " + err.message;
      }
    },
  }, "Speichern");
  einstellungenCard.appendChild(el("div", { class: "row" }, [zeitlimitSpeichernBtn]));
  content.appendChild(einstellungenCard);

  try {
    const einst = await api("/einstellungen");
    zeitlimitInput.value = einst.sekunden_pro_vokabel;
  } catch (err) {
    zeitlimitHinweis.textContent = "Konnte aktuelle Einstellung nicht laden: " + err.message;
  }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "Benutzer"));
  const liste = el("div");
  card.appendChild(liste);
  content.appendChild(card);

  let daten;
  try {
    daten = await api("/admin/users");
  } catch (err) {
    liste.appendChild(el("p", {}, "Fehler beim Laden: " + err.message));
    return;
  }

  if (daten.nutzer.length === 0) {
    liste.appendChild(el("p", { class: "hinweis" }, "Keine Benutzer."));
    return;
  }

  for (const n of daten.nutzer) {
    const istIch = n.username === aktuellerNutzer.username;
    const entfernenBtn = el("button", {
      class: "secondary",
      onclick: async () => {
        if (!confirm(`Benutzer "${n.username}" wirklich entfernen? Alle seine Lektionen und Logs werden ebenfalls gelöscht.`)) return;
        try {
          await api(`/admin/users/${encodeURIComponent(n.username)}`, { method: "DELETE" });
          zeigeAdmin();
        } catch (err) {
          alert("Fehler: " + err.message);
        }
      },
    }, "Entfernen");
    if (istIch) {
      entfernenBtn.disabled = true;
      entfernenBtn.title = "Das eigene Konto kann hier nicht entfernt werden.";
    }
    liste.appendChild(el("div", { class: "lektion-item" }, [
      el("span", { class: "name" }, n.username + (n.ist_admin ? " (Administrator)" : "")),
      el("span", { class: "aktionen" }, [entfernenBtn]),
    ]));
  }
}

// ---------------------------------------------------------------------
// Start: prüfen, ob bereits eine gültige Sitzung besteht
// ---------------------------------------------------------------------
async function init() {
  try {
    const res = await fetch(API + "/auth/me");
    if (!res.ok) throw new Error("nicht angemeldet");
    aktuellerNutzer = await res.json();
    renderKontoLeiste();
    zeigeStartseite();
  } catch (err) {
    zeigeLogin();
  }
}
init();
