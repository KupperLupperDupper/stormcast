# Backlog: stormcast

Køen på tværs af sessioner (PRJ-04): én tabel pr. bane (swimlane), og hvert punkt har et fast ID (PRJ-03). Baner er områder eller milepæle. Et punkt siger, hvornår det er færdigt.

- **Status:** Idé · Næste · I gang (session eller gren) · Venter (på hvad) · Færdig (dato)
- **Regler:** sæt et punkt til "I gang" med sessionens navn, før arbejdet starter, og højst ét pr. session. Rør ikke punkter, der er i gang hos andre. Commit-beskeden nævner ID'et. Færdige punkter flyttes til Arkiv, når de er en måned gamle.
- **Næste ID:** B-011

## Bane: Projekt
| ID | Punkt | Status | Note |
|---|---|---|---|
| B-001 | Udfyld docs/BRAIN.md, så en ny session finder rundt uden at søge | Færdig (2026-11-15) | Kortet og kommandoerne er flyttet fra `CLAUDE.md` |
| B-002 | Beskriv systemet i docs/ARCHITECTURE.md, som det er bygget | Færdig (2026-11-15) | Ud fra README, PROTOCOL.md, `CLAUDE.md` og commit-beskederne |

## Bane: Spejling
| ID | Punkt | Status | Note |
|---|---|---|---|
| B-003 | Fuldskærmsvisning af telefonbilledet | Idé | Grenen `claude/fullscreen-view-10afda` findes, men har ingen egne commits |
| B-004 | Trådløs forbindelse uden USB-kabel | Idé | README kalder den planlagt |
| B-007 | Vis flere enheder på én gang | Idé | Færdig, når to tilsluttede enheder spejles og styres samtidig |
| B-008 | Diagnostik om enheden | Idé | Fx model, Android-version, opløsning, batteri og forbindelsens tilstand |

## Bane: UI
| ID | Punkt | Status | Note |
|---|---|---|---|
| B-009 | Adskil enhederne i faner | Idé | Hænger sammen med B-007 |
| B-010 | Bedre layout af knapperne | Idé | Følg UI-rulebooken (CMP-02: mindst 24 px med mus) |

## Bane: Release
| ID | Punkt | Status | Note |
|---|---|---|---|
| B-005 | Udgiv 0.2.0 med lyden, der står under Unreleased i `CHANGELOG.md` | Idé | Tagget skal matche `version` i `package.json` |
| B-006 | Kodesignér installer og zip, så SmartScreen ikke advarer | Idé | Kendt problem i 0.1.0 |

## Arkiv
| ID | Punkt | Status | Note |
|---|---|---|---|
