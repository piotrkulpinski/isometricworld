# Licences, data sources and attribution

Everything on the map is built from open data. No Google, Apple, Bing or other proprietary map content
(imagery, 3D tiles, geometry) is used, not even as a reference.

## This repository

| What | Licence |
|---|---|
| Source code (`pipeline/`, `web/`, scripts) | [MIT](LICENSE) |
| Map imagery (published tiles), `video/`, `pipeline/style/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) by Dmytro Krasun, **plus the data credits below**, which must be kept with any copy |

The imagery and videos are *Produced Works* under the ODbL (see OpenStreetMap below): their own licence is
free to choose, but the OpenStreetMap notice must stay with them. AI-painted images may not be protected by
copyright everywhere; where they are, CC BY 4.0 applies.

## Credit line

Shown on the map (footer), in video mode and on every clip; use it on reposts, captions and end cards:

> Map data © OpenStreetMap contributors · Tel Aviv-Yafo Municipality · Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI

Each region lists its own credit lines in `pipeline/src/places.ts` (`credits`).

## Data sources

| Source | Used for | Licence | Obligations |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) (via the Overpass API) | ground (roads, pavements, parks, beach, coastline, water, rail, landuse), buildings outside Tel Aviv-Yafo, municipal borders, roads for the traffic animation | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | "© OpenStreetMap contributors" visible with the map and videos. Map images and videos are Produced Works (no share-alike on them). The data the pipeline derives by joining OSM with other data is a Derivative Database: it is not redistributed, and `pipeline/` (this repository) is the published method to recreate it. |
| [Tel Aviv-Yafo Municipality GIS](https://opendatasource.tel-aviv.gov.il/) (layer 513 buildings, layer 574 tree canopy 2024) | building footprints and surveyed heights, trees in Tel Aviv-Yafo | Municipal open-data terms (the Hebrew text is binding) | Cite the source. |
| [GUGiK 3D building models LoD1 2024](https://www.geoportal.gov.pl/pl/dane/inne-dane/modele-3d-budynkow/) (Główny Urząd Geodezji i Kartografii, Poland's national mapping agency) | building footprints, LiDAR-measured heights and ground elevation in Poland (Kraków: powiat 1261) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([dane.gov.pl](https://dane.gov.pl/dataset/2030)) | Credit: "Opracowano na podstawie materiałów państwowego zasobu geodezyjnego i kartograficznego (GUGiK, geoportal.gov.pl), CC BY 4.0". |
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) (AWS Open Data) | terrain height | Copernicus DEM licence: free, including commercial use | "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". |

None of this data is in the repository: `npm run fetch` downloads it into `data/` (ignored by git).

## AI painting

Render tiles are repainted by OpenAI's image model through the Codex CLI (ChatGPT account). OpenAI's terms
assign the output rights to the user. No credit is required; the map and clips say "Painted with AI" because
social platforms ask for AI-generated content to be labelled.

Everything in `pipeline/style/` was painted the same way for this project: `reference.png` (the house style,
a stretch of the painted Tel Aviv map: Gordon beach and the city behind it), `trees.png` (tree species
sheet) and `sea.png` (sea texture).

## Software

[three.js](https://threejs.org) (MIT), [OpenSeadragon](https://openseadragon.github.io) (BSD-3-Clause),
[Astro](https://astro.build) (MIT), [sharp](https://sharp.pixelplumbing.com) (Apache-2.0),
[Playwright](https://playwright.dev) (Apache-2.0), [esbuild](https://esbuild.github.io) (MIT),
[tsx](https://tsx.is) (MIT), [FFmpeg](https://ffmpeg.org) (LGPL/GPL, used as an external tool only),
[gifsicle](https://www.lcdf.org/gifsicle/) (GPL-2.0, external tool only). Installed from npm or the system package manager,
not vendored; their licences come with them.

This is not legal advice.
