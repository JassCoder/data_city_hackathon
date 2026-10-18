# Data sources

SkyRoute Warsaw is a planning and simulation prototype. **No data in this repository establishes real-world flight legality.** Before any real flight, check the current zones in PAŻP DroneTower or DroneMap.

## Summary

| Data | Source | Type | Where |
|---|---|---|---|
| **City boundary + 18 districts** | **GUGiK – Państwowy Rejestr Granic (PRG)**, OGC API Features | Official, cached snapshot (2026-10-17) | `data/boundaries/warsaw_city.geojson`, `warsaw_districts.geojson` (`scripts/fetch_boundaries.py`) |
| Buildings (height), river, parks | © OpenStreetMap contributors (ODbL), via Overpass API | Real citywide snapshot (2026-10-17): 189,276 buildings | `data/osm/grid_warsaw_25m.npz` (routing raster), `data/osm/tiles/14/…` (display), `data/corridors.geojson`, `data/tall_buildings.geojson` (`scripts/fetch_osm.py`) |
| **UAS geographical zones** | **No dataset loaded by default** | Unavailable until a permitted file is configured | `SKYROUTE_AIRSPACE_PROVIDER` / `SKYROUTE_AIRSPACE_FILE` |
| Landing stations | SkyRoute sample data | Synthetic; not real facilities | `data/landing_stations.geojson` |
| Drone profiles | SkyRoute sample data | Synthetic illustrative assumptions | `data/drone_profiles.json` |
| **Building-level addresses** | **GUGiK – Państwowy Rejestr Granic (PRG) address points**, via the public GUGiK geocoding service (UUG, `services.gugik.gov.pl/uug`) | Official open data, live, server-side, ≤ 5 requests/s, cached 24 h; exact building numbers only | `backend/app/services/address.py` |
| Address search (places, fallback) | Nominatim (© OpenStreetMap contributors) | Live, server-side, at most 1 request/s, cached 24 h | `backend/app/services/geocoding.py` |
| Building entrances | © OpenStreetMap contributors (ODbL), `entrance=*` nodes | Real snapshot (2026-10-18): 26,772 entrances, 10,049 with `addr:flats` | `data/osm/entrances.json.gz` (`scripts/fetch_entrances.py`) |
| Wind (LIVE/SAMPLE mode) | Open-Meteo / fixed sample | LIVE by default in the UI. On failure the last live values are shown as CACHED (≤ 3 h); otherwise sample wind is labelled "NOT live data" | `backend/app/services/weather.py` |
| Map tiles | © OpenStreetMap contributors | Live tiles | frontend |
| **Hospitals** | © OpenStreetMap contributors (ODbL), Overpass: `amenity=hospital` / `healthcare=hospital` | Real snapshot (2026-10-18): 45 facilities after campus deduplication. **Not guaranteed complete.** | `data/pois/hospitals.geojson` (`scripts/fetch_pois.py`) |
| **Restaurants** | © OpenStreetMap contributors (ODbL), Overpass: `amenity=restaurant` | Real snapshot (2026-10-18): 1,972 POIs. **Not guaranteed complete.** | `data/pois/restaurants.geojson` |
| Airports | © OpenStreetMap contributors (ODbL), `aeroway=aerodrome` | Real footprints (EPWA, EPBC and 2 nearby airfields); informative, not drone zones | `data/airports.geojson` (`scripts/fetch_airports.py`) |
| Drone stations, depots, pads, drones, orders, subscriptions | SkyRoute simulation | **Simulated.** Planning sites and fictional DEMO partners, never approvals. | `data/fleet/fleet.sqlite` (seeded by `backend/app/fleet/seed.py`) |

## Addresses and entrances

- **GUGiK PRG address points:** `GetAddress` requests return exact building-number matches with accuracy scores.
  - **Street re-check:** the service's fuzzy street matching can return a different street (tested: "ulica Nowy Świat 15" returned "ulica Nowa 15"). Every result is therefore re-checked: all significant words of the requested street must appear in the returned one, otherwise the result is dropped.
  - **Missing numbers:** some numbers are absent from the register (e.g. Marszałkowska 100). These fall back to Nominatim, labelled street- or place-level.
- **Flats:** never geolocated. The point is the building, and the response says so (`flatResolved: false`).
- **Entrances:** OSM `entrance=*` nodes on the outline (±3 m) of the building footprint that contains (or is within 20 m of) the address point.
  - An entrance is linked to a flat only when its `addr:flats` tag covers that flat.
  - Entrances are for delivery planning, not drone landing sites.

## Hospitals and restaurants (OpenStreetMap)

- **Import:** `scripts/fetch_pois.py` queries nodes, ways and relations in 16 small Overpass tiles. It pauses between requests and sends a descriptive User-Agent.
- **Clipping:** features are kept when their representative point lies inside the GUGiK Warsaw polygon. Each gets its district.
- **Deduplication, hospitals:** one record per facility.
  - Parts inside a mapped campus that share its name, or are unnamed, merge into it.
  - Same-name features within 250 m merge.
  - Name variants (one name contained in the other, such as "X" and "Państwowy X") within 400 m merge.
  - Merged OSM ids are kept in `mergedOsmIds`.
- **Deduplication, restaurants:** a node and a polygon with the same name within 30 m are one POI.
- **Never invented:** unnamed features keep `name: null`.
- **Kept per record:** source id, address, website and phone when tagged, completeness flags and the import time.
- **Import results:**
  - **Hospitals:** 54 raw elements → 46 inside Warsaw → 45 facilities in 14 districts. No hospital is mapped in Bemowo, Rembertów, Ursus or Włochy.
  - **Restaurants:** 2,147 raw elements → 1,976 inside Warsaw → 1,972 POIs in all 18 districts.
- **Completeness:** OSM is volunteer-mapped. The lists can miss operating facilities and contain outdated tags.
- **What these records mean:** they are locations only. Drone stations and pads are separate simulated records (PROPOSED, REVIEW_REQUIRED, SIMULATION_ENABLED, VERIFIED_BY_OPERATOR or DISABLED). The operator verification status is not regulatory approval. DEMO partners are fictional subscriptions.

## Warsaw administrative boundary

- **Source:** GUGiK's national register of boundaries (PRG), through its documented public OGC API Features service: `https://ogcapi.geoportal.gov.pl/res/ims/maps/PRG/apiFeatures/collections`.
- **How features are selected:** by **TERYT code**, not by name.
  - The city: collection `GranicaPowiatu`, `kod == "1465"` ("powiat Warszawa", a city with county rights, 516.7 km²).
  - The 18 districts: collection `GranicaJednostkiEwidencyjnej`, `kod` `146502_8` … `146519_8`.
  - This cannot be confused with neighbouring counties (warszawski zachodni, 1432) or the metropolitan area.
- **Checks:** the script refuses to write unless it finds exactly 1 city and 18 districts whose union matches the city area within 1%.
- **Use:** the city polygon is the routing coverage. Every point is validated against it with a point-in-polygon test, on both the backend and the frontend.
- **Metadata kept:** the PRG version id, the "valid from" date and the retrieval time.

## Polish UAS geographical zones: what official data is available

This research was carried out on 2026-10-17. The goal was a documented, permitted, machine-readable source of Polish UAS geographical zones (DRA-P/R/T/U/I).

| Checked | Finding |
|---|---|
| [pansa.pl/strefy-geograficzne](https://www.pansa.pl/strefy-geograficzne/) | Defines the zone types (see below). Points pilots to DroneTower and DroneMap for viewing. **No dataset, API, ED-269/ED-318 file or data-access terms.** |
| [pansa.pl/dane](https://www.pansa.pl/dane/) ("Dane", PAŻP data products) | Lists radar data, meteorological data (Chopin airport) and flight statistics. **No UAS zone dataset.** Access is by contact with PAŻP (info@pansa.pl). |
| [dronemap.pansa.pl](https://dronemap.pansa.pl/) | A JavaScript map application. It loads zone data from a backend (`api.dronemap.pansa.pl`) that PAŻP **does not publicly document**, and no terms for third-party use were found. A community QGIS plugin ("PANSA DroneMap Downloader") calls that backend, but it is not a PAŻP product. **Not used:** calling an undocumented service would break this project's data rules. |
| [airspace.pansa.pl](https://airspace.pansa.pl/) | AUP/UUP (airspace use plan) viewer. **No documented API or download.** |
| [drony.gov.pl](https://www.drony.gov.pl/) | Drone portal (DSS, mission planning). **No zone datasets or API mentioned.** |
| EU context | Regulation (EU) 2019/947 Art. 15 requires states to publish geographical zones in a common digital format (EUROCAE ED-269, now ED-318). A third-party survey ([unmannedairspace.info](https://www.unmannedairspace.info/uncategorized/just-eleven-european-countries-publish-uas-geo-zone-information-in-correct-format/)) did not list Poland among countries that publish a usable file. This was not independently confirmed. |

**Re-check on 2026-10-18** (prompted by the citywide coverage work):

| Checked | Finding |
|---|---|
| [pansa.pl/strefy-geograficzne](https://www.pansa.pl/strefy-geograficzne/) | Unchanged: zones are viewable in DroneMap, DroneTower and PansaUTM. **No dataset, API, ED-269/ED-318 file or terms.** Around controlled airports, the page says DRA-R zones inside CTRs generally require PAŻP consent (mission plan via KISD), with exceptions in a table image. |
| [ais.pansa.pl – AIP Data Set](https://www.ais.pansa.pl/en/publications/aip-data-set/) and its [Data Product Specification](https://docs.pansa.pl/ais/dps/DPS_AIP_Dataset_PANSA_AIXM_5.1_ver_1.4.pdf) | An **official AIXM 5.1** data set (AIRAC cycle).<ul><li>**Coverage:** FIR EPWW; ATS airspace (e.g. CTR/ATZ) and special-activity airspace (P/R/D, with activation).</li><li>**Access:** "For subscribers only" (order form), with "Use limitations: For aviation use only".</li><li>**Not UAS zones:** it does **not** list UAS geographical zones (DRA-*).</li></ul>**Not integrated:** it needs a subscription, and its manned-aviation airspace (CTR, ATZ, P/R/D) is not the same thing as a UAS geographical zone. Mapping a CTR to a DRA category would misstate the rules. |
| PAŻP "strefy.kml" (older page) | A KML of ATZ/CTR for manned aviation, several years old, with no reuse terms. **Not used.** |
| Third-party survey (DroneTrace, via search) | Lists Poland among countries that publish no ED-269 file. Not independently confirmed. |

**Airports (EPWA Chopin, EPBC Babice):**
- **No official machine-readable UAS-zone geometry was found** for either airport. Their UAS restrictions (DRA-R zones inside the CTR, height limits depending on distance) are published only in DroneMap/DroneTower.
- **What SkyRoute renders:** **nothing** for them. Following the project rules, no circle or buffer is drawn around an airport.
- **Tests:** airport behaviour is covered by synthetic test fixtures (`TEST-AIRPORT-EPWA`, a restriction from 40 m AGL; `TEST-AIRPORT-EPBC`, a ceiling of 150 m AMSL) in `backend/tests/citywide_zones.py`. They are never loaded by the app.
- **What it takes:** once an official ED-269 export is available, the airport zones come in with it and are evaluated and avoided like any other zone.

**Result:**
- No documented, permitted official API or downloadable zone file was found.
- **No official API integration was attempted or succeeded.**
- The app does not bundle or load zone data by default. It only loads official snapshots from permitted local files.

### Zone categories (from PAŻP)

| Category | Meaning (PAŻP) | SkyRoute default for a simulated flight |
|---|---|---|
| DRA-P | Prohibited: only narrowly defined state services, under PAŻP conditions | **Blocked** (RED) |
| DRA-R | Restricted: flights need consent and conditions from PAŻP or the zone requester | **Unavailable** without a recorded authorization (RED with a red boundary, routing obstacle) |
| DRA-RH / RM / RL | Restricted, with a *high / medium / low likelihood* of consent being granted | Same as DRA-R. The likelihood is shown, never treated as permission. |
| DRA-T | Technical requirements for the UAS; consent may also be required | **Unavailable** unless the requirements are verified (YELLOW, routing obstacle) |
| DRA-U | U-space: operations only with verified U-space services | **Unavailable** (ORANGE, routing obstacle) |
| DRA-I | Information, including navigation warnings | **Warning only** (YELLOW). Blocks only if its restriction type independently requires it. |
| Unknown / incomplete | | **Treated as blocked** (GRAY) |

Each zone is evaluated for the planned flight:
- **Validity period:** a zone outside its period is inactive. An unknown period means active.
- **Altitude band:** the zone band is compared with the cruise altitude ± 10 m, or from the ground up at take-off and landing. An unknown limit means unlimited on that side. AMSL limits are compared using a terrain range of 75–120 m AMSL (no DEM).
- **Category:** applied as in the table above.

## What is needed for official data

1. **Permission and a dataset from PAŻP:** a machine-readable export of the UAS geographical zones for the Warsaw area, ideally ED-269/ED-318 JSON, with licence or terms that allow use in this application. It must state its currency (issue date, update cycle). Contact: info@pansa.pl, [pansa.pl/drony-kontakt](https://www.pansa.pl/drony-kontakt/), or the [PAŻP help centre](https://pansa.atlassian.net/servicedesk/customer/portals).
2. **Or a documented API** with terms of use and credentials. A live provider would then be added next to the file providers. No credentials are needed today, because no such API is published.
3. **For time-limited zones** (for example temporary reservations): activation data (AUP/UUP) through an authorized channel. Without it, SkyRoute treats a zone as active for its whole validity period.

### Plugging in an official file

```bash
# ED-269-style JSON export
SKYROUTE_AIRSPACE_PROVIDER=ed269   SKYROUTE_AIRSPACE_FILE=/path/to/pansa_zones.json
# or a file already converted to SkyRoute's normalized GeoJSON (see app/airspace/models.py)
SKYROUTE_AIRSPACE_PROVIDER=geojson SKYROUTE_AIRSPACE_FILE=/path/to/zones.geojson
```

Several files (for example permanent zones plus a file of temporary restrictions) can be listed in `SKYROUTE_AIRSPACE_FILE`, separated by the OS path separator (`;` on Windows, `:` elsewhere). They are merged as follows:
- **Exact duplicates** (same id, same content) are dropped.
- **Same id, different content** rejects the update, and the last good dataset stays loaded.
- **Source type and coverage:** the merged dataset takes the weakest source type and the union of the extents.

The data is marked `PERMITTED_SNAPSHOT` and `OFFICIAL_UNVERIFIED_LOCALLY`, and the UI shows it as "Official snapshot (permitted file)". If the file changes while the server runs, it is reloaded on the next request, and routes planned on the old version are marked outdated. If an update is broken, the server keeps the last good version.

ED-269 mapping (`Ed269FileProvider`):

| ED-269 field | SkyRoute field |
|---|---|
| `restriction` | `restrictionType`: `PROHIBITED`, `REQ_AUTHORISATION` → `AUTHORIZATION_REQUIRED`, `CONDITIONAL`, `NO_RESTRICTION` → `INFORMATION` |
| A `DRA-x` label in `name`, `identifier`, `otherReasonInfo` or `message` | `draCategory` (otherwise `UNKNOWN`) |
| Volumes | Merged into one envelope: lowest floor and highest ceiling. Feet are converted to metres. |
| `Circle` (`center` + `radius`) | A 128-vertex geodesic polygon, with the original circle kept |
| `applicability` | Validity start and end (schedules are noted, not evaluated) |

**Caveat:** this mapping follows the ED-269 structure but has **not** been checked against a real PAŻP file, because none was available. Review it when the file arrives. Vertical references other than AGL or AMSL become `UNKNOWN`, which conservatively means the zone applies at every altitude.

## Planning constraints (OpenStreetMap, SkyRoute policy)

`data/planning_constraints.geojson` comes from `scripts/fetch_planning_constraints.py` (Overpass, one-off; ODbL). It holds the mapped footprints of `aeroway=aerodrome` (Chopin EPWA, Babice EPBC), `landuse=military` / `military=*` areas, and `office=government` / `building=government` areas plus the buildings that contain `office=government` points. The Sejm relation is a broken OSM multipolygon; the script rebuilds it from its own outer ways. Fetched 2026-10-18: 2 airports, 86 military areas, 477 government buildings, about 15.9 km².

These are **not** UAS geographical zones. SkyRoute avoids them as its own planning policy (`SKYROUTE_PLANNING_CONSTRAINTS=on`, the default). They are drawn red and labelled "planning constraint, not an official no-fly zone". Real airport restrictions are much larger than the airport grounds (the Chopin CTR, DRA-R) and still need an official zone file. Government and military coverage depends on OSM tagging and is incomplete.

## Default airspace configuration

The repository does not bundle a zone dataset. The default provider is `none`; `/zones` returns an empty list, routing reports the entire route as unchecked, and airspace verification is unavailable. Unknown airspace is not unrestricted airspace.

Official zones may be supplied only as a permitted local file using `SKYROUTE_AIRSPACE_PROVIDER=ed269|geojson` and `SKYROUTE_AIRSPACE_FILE`. The app does not call PAŻP or scrape DroneMap.

For local software testing only, `scripts/build_sample_data.py` can create synthetic example zones at `data/airspace/sample_zones.geojson`. This optional output is not official and is not loaded unless explicitly selected as a file provider. Its fictional boundaries and categories must never be treated as real restrictions.
