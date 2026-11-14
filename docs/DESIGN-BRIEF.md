# Design-brief: Stormcast

Projektets valg: stil, tokens, tone og bevidste afvigelser. Reglerne står i UI-rulebooken og gentages ikke her.

- **Rulebook-version:** 1.1.2 (`~/docs/ui-rulebook`)
- **Senest opdateret:** 14.11.2026

## Brugere og sammenhæng
- Folk, der vil se eller vise deres Android-skærm på en Windows-PC: udviklere, testere, undervisere og folk, der præsenterer. Sessioner fra få minutter til timer.
- Skærme: bærbar og stationær PC fra 1366 × 768 til 4K og 100–200 % skalering. Vinduet står ofte lille ved siden af andre vinduer.
- Input: mus og tastatur, og touch på Windows-tablets og 2-i-1.
- Sprog: engelsk UI, fordi projektet er public. Al tekst ligger i `src/strings.ts`.

## Stil (STY-02)
- **Primær stil:** Glassmorphism, bygget på Fluent-materialet Acrylic (Windows 11, build 22621+).
- **Fallback-skin:** Fluent solid (Flat 2.0) på Windows 10, og når gennemsigtighedseffekter er slået fra. Samme layout, komponenter og regler; kun tokens skifter (STY-01).
- **Hvorfor:** Ønsket er et moderne glasudtryk, og Windows 11 har det som systemmateriale. Glas passer til navigation og kontrolflader omkring medier (stilkataloget), og telefonbilledet er netop medie.
- **Stilens risici og vores afhjælpning:**
  - Kontrasten svinger med baggrunden → paneler med tekst har 62 % fyld, og kontrasten måles i hånden over et hvidt og et sort skrivebord.
  - Tekst → står altid på et panel, aldrig direkte på glasset.
  - Glas på glas → aldrig. Blur kommer kun fra vinduets akryl; panelerne har ingen blur af deres egen.
  - "Reducér gennemsigtighed" → det solide skin. Windows' indstilling læses ved start.
  - Høj kontrast → systemfarver via `forced-colors`.
  - Telefonbilledet ligger aldrig under glas eller andre lag.

## Tokens
- **Kilde:** `src/styles/tokens.css`. Lag 1 er primitiver, lag 2 semantiske roller og lag 3 komponenter; UI'et bruger kun lag 2 og 3 (TOK-02).
- **Generering og test for forældede filer:** ingen generering; filen er eneste kilde. `npm run check:contrast` læser den direkte.

| Rolle | Lys | Mørk | Kontrast |
|---|---|---|---|
| tekst på baggrund | #1b1b1b på #f3f3f3 | #ffffff på #202020 | 15,5:1 / 16,3:1 |
| dæmpet tekst på flade | #5d5d5d på #fbfbfb | #c5c5c5 på #2b2b2b | 6,4:1 / 8,2:1 |
| accent som fyld + on-accent | #ffffff på #005fb8 | #000000 på #60cdff | 6,3:1 / 11,7:1 |
| fare | #c42b1c på #fbfbfb | #ff99a4 på #2b2b2b | 5,5:1 / 7,0:1 |

Tallene gælder det solide skin og tjekkes af `npm run check:contrast` i CI (QA-02). Glaspanelerne er halvgennemsigtige og tjekkes i hånden.

- **Typografi:** Segoe UI Variable (Text og Display) med Segoe UI som fallback. Fluents skala: caption 12/16, body 14/20, subtitle 20/28, title 28/36. Cascadia Mono til kommandoer og tekniske detaljer.
- **Bevægelsens personlighed:** crisp. Hover og tryk på 100 ms med ease-out; ingen bounce (MOT-03, MOT-08). Fremdriftslinjen er den eneste løkke, og den står stille ved reduceret bevægelse.

## Tone
Korte sætninger uden udråbstegn. Knapper siger handlingen: "Mirror screen", "Stop mirroring", "Try again". Fejl siger, hvad der skete, og hvad man gør nu.

## Særlige krav
- Telefonbilledet vises i sin egen opløsning, skaleret til pladsen, og intet ligger ovenpå.
- Knapper er 40 px høje med et trykområde på 48 px (CMP-02).
- Lav forsinkelse: hardware-afkodning, og det nyeste billede vinder.
- Styring: mus, touch og pen bliver til touch på enheden, hjulet til scroll og tastaturet til taster og tekst, mens skærmen har fokus. Fokus vises med en accentring uden om billedet og en hjælpetekst, der siger, at Tab forlader skærmen, så tastaturet aldrig fanges (A11Y-03, WCAG 2.1.2). Tab, zoom med Ctrl og Alt+F4 bliver i appen.
- Input sendes med det samme og i rækkefølge, uden debounce (PERF-05). Skærmen sender alle fingre videre, så enheden selv afgør knib og andre gestus; GES-05's "ignorér ekstra fingre" gælder egne gestus, og skærmen har ingen.
- Tilbage, Hjem, Seneste apps og Tænd/sluk er ikonknapper i værktøjslinjen med Androids egne symboler (GES-06). Navnet står i `aria-label` og i en tooltip ved hover og tastaturfokus (CMP-14, A11Y-05). Tooltippen har solid flade, så den aldrig er glas på glas, og lægger sig aldrig over telefonbilledet. "Stop mirroring" er tekst, fordi det er Stormcasts egen handling, og et stop-ikon ville ligne Seneste apps.
- Udklipsholder: det, der kopieres på enheden, kommer af sig selv i PC'ens udklipsholder, og Ctrl+V på skærmen indsætter PC'ens tekst på enheden. Kun tekst, og indholdet logges aldrig.
- Højreklik er Tilbage, som med en mus på Android selv (GES-07). Et museklik på enhedsknapperne flytter ikke fokus fra skærmen, så man kan skrive videre.

## Afvigelser (KIT-04)

| Regel | Afvigelse | Begrundelse | Dato |
|---|---|---|---|
| TOK-01 | Breakpointet `40rem` står i `app.css` | CSS tillader ikke custom properties i media queries | 14.11.2026 |

## Tjek i projektet (QA-02)
- CI (`.github/workflows/ci.yml`): typecheck og build, kontrast-tjek, `cargo fmt`, `clippy` og Rust-tests.
- Rigtig enhed (QA-04): røgtesten med `STORMCAST_SMOKE=1` spejler den første klar enhed, tæller afkodede billeder, trykker Seneste apps og Tilbage og måler tiden fra input til nyt billede.
- I hånden indtil videre: glaspanelernes kontrast over hvidt og sort skrivebord, skærmlæser (A11Y-08) og 200 % zoom (TYP-02).
