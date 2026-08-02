# Seilbåter — annonse-tracker

Personlig verktøy som overvåker seilbåt-annonser på tvers av portaler. Du limer inn URL-en til en annonse i `boats.json`. En GitHub Action kjører én gang i døgnet, henter hver annonse på nytt, oppdager pris- og status-endringer og sender én samlemail hvis noe har endret seg. Frontenden på GitHub Pages viser lista, sorterbar.

## Legge til en båt

1. Åpne `boats.json` her i GitHub-webbet
2. Trykk blyant-ikonet for å redigere
3. Legg til et nytt objekt i `boats`-arrayet, minimum:
   ```json
   { "url": "https://www.yachtworld.com/yacht/..." }
   ```
4. Commit direkte til `main`
5. Neste daglige kjøring fyller inn tittel, pris, status og starter historikken. Vil du ikke vente — trigg manuelt (se under).

## Trigge en manuell kjøring

Actions-fanen → "Daily check" → "Run workflow" → "Run workflow" (grønn knapp).

## Secrets (må settes én gang)

Settings → Secrets and variables → Actions → New repository secret:

| Navn            | Verdi                                               |
|-----------------|-----------------------------------------------------|
| `MAIL_USERNAME` | Din Gmail-adresse                                   |
| `MAIL_PASSWORD` | Gmail app-passord (16 tegn) — krever 2FA           |
| `MAIL_TO`       | Mailadressen som skal motta oppsummeringen         |

App-passord: https://myaccount.google.com/apppasswords

## Hvordan det virker

Scriptet i `scripts/check.mjs` prøver å lese hver annonse med tre lag i denne rekkefølgen:

1. **JSON-LD `Product`** — strukturert data mange portaler eksponerer
2. **OpenGraph / meta-tagger** — `og:price:amount`, `product:availability`, osv.
3. **Heuristikk** — søk i sidetekst etter pris-mønstre og statusord (`sold`, `solgt`, `reserved`, `reservert`, `sale pending`, …)

Hvilken metode som traff logges per felt i `parseSources` på hver båt. Sider som ikke lar seg lese markeres `parseFailed: true` og du får mail første gang det skjer — og når de begynner å funke igjen. Sider som krever JavaScript for å rendre pris (client-side apps, Cloudflare-beskyttelse) vil sannsynligvis feile. Da må vi enten skrive en spesifikk parser for den siden eller ta inn en headless browser i workflowen.

## Frontend

GitHub Pages serverer roten av repoet. Åpne `https://<brukernavn>.github.io/<repo>/` for å se lista.

Slå på Pages: Settings → Pages → Source: Deploy from a branch, Branch: `main`, folder: `/ (root)`.

## Skru av

Actions-fanen → "Daily check" → "..." → "Disable workflow".
