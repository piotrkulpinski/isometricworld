# Landmark prompts

Per landmark, the text `src/landmark.ts` sends to Codex (the image list and output line are added by the tool):
`overview.txt` (the one coherent painting) and `key.txt` (what stays when everything else turns magenta). Edits that were
pasted back by box are listed per landmark below, so a landmark can be recreated.

- `wasen` (stuttgart-core, Cannstatter Volksfest): frame 3630,6880,3600,2400, `--base render --style reference-simple.png`,
  refs (PD/CC0, see ATTRIBUTION.md) `Volksfest_2010_Blick_aus_dem_Riesenrad.jpg`, `Cannstatter_Wasen_30092013_4.jpg`.
  Then a tower edit (box 1140,254,1245,405) and a Fruchtsäule edit (355,480,450,635); windows 4..7 × 8..9 painted with
  `paint.ts --guide`. Made before this tool: its files are in overview-wasen-v4/ and overview-wasen-key/.
- `arena` (stuttgart-east, MHPArena): frame 1760,10200,1536,1024, `--base paint --aerial`. Files in overview-arena/ and
  overview-arena-key/ (made before this tool).
- `neues-schloss`, `kunstgebaeude`, `landtag`, `staatstheater` (stuttgart-core, Schlossgarten): one native frame each
  (-990,-1100 / -420,-1100 / -904,-622 / -325,-258, all 1536×1024), `--base render --aerial --aerial-source city
  --style reference-simple.png`, refs from `data/raw/photos/neues-schloss/`, `kunstgebaeude/`, `landtag/`, `oper/` +
  `schauspielhaus/` (PD/CC0/CC BY, see ATTRIBUTION.md). No edits. The Landtag key was run twice (the first came back
  tinted instead of flat magenta: check that the mask is a few % of the frame).
- `wawel` (krakow-test, Wawel Royal Castle and Cathedral): frame -15641,-33493,1536,1024, `--base paint --tag
  krakow-pilot-2c` (an experiment: reads paint-krakow-pilot-2c/, records into cutouts-krakow-pilot-2c.json), refs from
  `data/raw/photos/wawel/` (CC BY, see ATTRIBUTION.md). No edits; the first overview read as Wawel (match 0.91).
- `cracovia` (krakow-test, Stadion Cracovii): frame -18580,-35990,1536,1024, `--base paint --tag krakow-pilot-2c`, painted
  from the render with the open stands (landmarks/stadium.ts), refs from `data/raw/photos/cracovia/` (CC BY). No edits.
- `wisla` (krakow-mid-2, Stadion Miejski im. Henryka Reymana): frame -19428,-38427,1536,1024, `--base paint`, refs
  `star-end-stand.jpg`, `star-and-lettering.jpg`, `facade.jpg` from `data/raw/photos/wisla/` (CC BY, see ATTRIBUTION.md).
  The first overview came back zoomed out (match 0.03) and was dropped; the second matched 0.46. No edits. Key with
  `--cleanup 24`: this overview redrew its surroundings slightly, and the full clean-up mask covered 85 % of the frame.
  WISŁA and 1906 sit on the south-east stand, whose seats face away from the camera, so they are not painted.
